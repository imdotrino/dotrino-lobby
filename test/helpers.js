// Helpers de test: hub en memoria que emula el proxy (ruteo por token, canales,
// presencia) + identidades falsas. No contiene tests (node --test lo ignora).
//
// EL HUB SELLA DE VERDAD. No simula el sellado: usa `seal`/`open` de
// `@dotrino/proxy-client` (que por dentro son `wrapForMember`/`openWrap` de
// `@dotrino/identity`), con un par ECDH real por endpoint. Así el hub ve
// exactamente lo que vería quien opera el proxio, y `hub.wire` es esa vista:
// sobre ella se comprueba que no viaja nada en claro.

import { Emitter } from '../src/util.js'
import { parseEnvelope } from '../src/protocol.js'
import { seal, open, isSealed, makeEncKeypair } from '@dotrino/proxy-client'

export class MockHub {
  constructor () {
    this.endpoints = new Map()
    this.channels = new Map()
    this.byPubkey = new Map()
    this.encPubs = new Map() // publickey → encPub anunciada (lo que hace el `identify`)
    /** Todo lo que pasa por el proxio, tal cual lo ve él. */
    this.wire = []
    this._n = 0
  }

  endpoint (opts = {}) {
    const token = opts.token || ('tk' + (++this._n))
    const ep = new MockTransport(this, token, opts.identity || null)
    this.endpoints.set(token, ep)
    if (opts.identity && opts.identity.me && opts.identity.me.publickey) this.byPubkey.set(opts.identity.me.publickey, token)
    return ep
  }

  /** Lo que el proxio guarda del `identify`: la llave de cifrado de cada identidad. */
  announce (publickey, encPub) { this.encPubs.set(publickey, encPub) }

  encPubOf (publickey) {
    const k = this.encPubs.get(publickey)
    if (!k) { const e = new Error('no encryption key announced for that identity'); e.code = 'no-encpub'; throw e }
    return k
  }

  record (from, to, payload) { this.wire.push({ from, to, payload }) }

  /** Todo lo que el proxio pudo LEER (lo que no venía sellado). */
  get plaintext () { return this.wire.filter(f => !isSealed(f.payload)).map(f => f.payload) }

  /** …y de eso, lo que NO es el saludo del transporte (que solo lleva llaves públicas). */
  get plaintextNoHello () { return this.plaintext.filter(p => !p || p.t !== HELLO_TAG) }

  route (from, to, payload) {
    const tos = Array.isArray(to) ? to : [to]
    this.record(from, tos, payload)
    for (const t of tos) {
      const ep = this.endpoints.get(t)
      if (!ep || ep._down) continue
      queueMicrotask(() => ep._deliver(from, payload))
    }
  }

  routeByPubkey (from, pubkeys, payload) {
    const arr = Array.isArray(pubkeys) ? pubkeys : [pubkeys]
    for (const pk of arr) { const t = this.byPubkey.get(pk); if (t) this.route(from, t, payload) }
  }

  join (token, channel) {
    let s = this.channels.get(channel)
    if (!s) { s = new Set(); this.channels.set(channel, s) }
    const others = [...s]
    s.add(token)
    for (const m of others) { const ep = this.endpoints.get(m); if (ep && !ep._down) ep.emit('channel_joined', channel, token) }
  }

  leave (token, channel) {
    const s = this.channels.get(channel)
    if (!s || !s.has(token)) return
    s.delete(token)
    for (const m of s) { const ep = this.endpoints.get(m); if (ep && !ep._down) ep.emit('channel_left', channel, token) }
  }

  members (channel) { const s = this.channels.get(channel); return s ? [...s] : [] }

  disconnect (token) {
    const ep = this.endpoints.get(token); if (!ep) return
    ep._down = true
    for (const [ch, s] of this.channels) {
      if (!s.has(token)) continue
      s.delete(token)
      for (const m of s) { const o = this.endpoints.get(m); if (o && !o._down) o.emit('peer_disconnected', token, ch) }
    }
  }
}

/** La misma marca que usa el transporte de verdad para su trama de control. */
export const HELLO_TAG = '__cc_hello__'

export class MockTransport extends Emitter {
  constructor (hub, token, identity) {
    super()
    this.hub = hub
    this._token = token
    this.identity = identity
    this._subs = new Map()
    this._down = false
    this._enc = null
    this._tokenPubkeys = new Map()
    this._helloSent = new Set()
    /** Lo que ESTE extremo mandó y recibió, ya abierto (para comprobar el juego). */
    this.sent = []
    this.received = []
  }

  get token () { return this._token }
  get isReady () { return !this._down }

  async connect () {
    await this._ensureEnc()
    return this._token
  }

  async _ensureEnc () {
    if (this._enc) return this._enc
    this._enc = await makeEncKeypair()
    const pk = this.identity && this.identity.me && this.identity.me.publickey
    // Es lo que hace `identify`: dejar anunciada la llave con la que me sellan.
    if (pk) this.hub.announce(pk, this._enc.encPub)
    return this._enc
  }

  subscribe (gameId, fn) {
    let s = this._subs.get(gameId); if (!s) { s = new Set(); this._subs.set(gameId, s) }
    s.add(fn); return () => { const x = this._subs.get(gameId); if (x) x.delete(fn) }
  }

  async _deliver (from, payload) {
    // El saludo es del TRANSPORTE: se atiende aquí y no sube a la app, igual que en el
    // pilar. Lleva una llave pública y nada más.
    if (payload && payload.t === HELLO_TAG) {
      if (typeof payload.publickey !== 'string') return
      this._tokenPubkeys.set(from, payload.publickey)
      if (!this._helloSent.has(from)) this.helloTo(from)
      this.emit('peer_identity', from, payload.publickey)
      return
    }
    let env = payload
    let sealed = false
    if (isSealed(payload)) {
      const mio = await this._ensureEnc()
      try { env = await open(payload, mio.privateKey) } catch (_) { return } // no era para mí
      sealed = true
    }
    const parsed = parseEnvelope(env); if (!parsed) return
    // LA MISMA REGLA QUE EL TRANSPORTE DE VERDAD (`requireSealed`): lo que no viene
    // sellado se tira, sin excepciones.
    if (!sealed) return
    this.received.push({ from, env: parsed, sealed })
    const subs = this._subs.get(parsed.g); if (!subs) return
    for (const fn of [...subs]) { try { fn(from, parsed, { via: 'mock', sealed }) } catch (e) { console.error(e) } }
  }

  // Simula una reconexión del WS: cae el token viejo (notifica peer_disconnected
  // a los canales) y el proxy asigna uno nuevo + emite 'reconnect'.
  reconnect (newToken) {
    const hub = this.hub
    const oldToken = this._token
    for (const [ch, s] of hub.channels) {
      if (!s.has(oldToken)) continue
      s.delete(oldToken)
      for (const m of s) { const o = hub.endpoints.get(m); if (o && !o._down) o.emit('peer_disconnected', oldToken, ch) }
    }
    hub.endpoints.delete(oldToken)
    this._token = newToken
    this._down = false
    hub.endpoints.set(newToken, this)
    if (this.identity && this.identity.me && this.identity.me.publickey) hub.byPubkey.set(this.identity.me.publickey, newToken)
    this.emit('reconnect', newToken)
  }

  // ── Envío (la misma superficie que src/transport.js) ────────────

  async sendSealedTo (token, env, peerPubkey) {
    peerPubkey = peerPubkey || this.pubkeyOfToken(token)
    if (!peerPubkey) {
      const e = new Error('nobody has said whose this token is')
      e.code = 'no-peer-identity'
      throw e
    }
    await this._ensureEnc()
    const sobre = await seal(env, this.hub.encPubOf(peerPubkey))
    this.sent.push({ to: token, env, sealed: true })
    this.hub.route(this._token, token, sobre)
  }

  async sendSealedByPubkey (pubkeys, env) {
    await this._ensureEnc()
    const arr = Array.isArray(pubkeys) ? pubkeys : [pubkeys]
    // Una envoltura por destinatario: cada uno tiene su llave.
    const sobres = await Promise.all(arr.map(async (pk) => [pk, await seal(env, this.hub.encPubOf(pk))]))
    for (const [pk, sobre] of sobres) {
      this.sent.push({ to: pk, env, sealed: true })
      this.hub.routeByPubkey(this._token, pk, sobre)
    }
  }

  // ── El saludo del transporte (lo que en el pilar hace `helloTo`) ──

  pubkeyOfToken (token) { return this._tokenPubkeys.get(token) || null }

  helloTo (token) {
    const pk = this.identity && this.identity.me && this.identity.me.publickey
    if (!pk) { const e = new Error('identify first'); e.code = 'not-identified'; throw e }
    for (const t of (Array.isArray(token) ? token : [token])) {
      if (!t || t === this._token) continue
      this._helloSent.add(t)
      this.hub.route(this._token, t, { t: HELLO_TAG, publickey: pk })
    }
  }

  peerIdentity (token, { timeout = 2000 } = {}) {
    const ya = this.pubkeyOfToken(token)
    if (ya) return Promise.resolve(ya)
    return new Promise((resolve, reject) => {
      const off = this.on('peer_identity', (t, pk) => { if (t !== token) return; clearTimeout(timer); off(); resolve(pk) })
      const timer = setTimeout(() => { off(); const e = new Error('never said whose it is'); e.code = 'no-peer-identity'; reject(e) }, timeout)
      try { this.helloTo(token) } catch (e) { clearTimeout(timer); off(); reject(e) }
    })
  }

  publish (channel) { this.hub.join(this._token, channel); return Promise.resolve({ ok: true }) }
  unpublish (channel) { this.hub.leave(this._token, channel); return Promise.resolve({ ok: true }) }
  list (channel) { return Promise.resolve(this.hub.members(channel)) }
  listChannels () { return Promise.resolve([]) }
  channelCount (channel) { return Promise.resolve(this.hub.members(channel).length) }
  connectWebRTC () { return Promise.resolve() }
  isWebRTCOpen () { return false }
}

/** Identidad falsa con pubkey estable; verify siempre ok; firmas deterministas. */
export function fakeIdentity (pubkey, nickname = null) {
  let c = 0
  return {
    me: { publickey: pubkey, nickname },
    // El vault devuelve el PAQUETE: firma, quién firmó y la cadena que dice que ese
    // aparato habla por esta identidad. Sin la cadena el registro no puede comprobar nada,
    // y el lobby se niega a co-firmar a medias.
    signData: async (data) => ({ signature: 'sig:' + pubkey + ':' + JSON.stringify(data), publickey: pubkey, profileId: pubkey, chain: [{ seq: 1, profileId: pubkey }] }),
    makeChallenge: async () => ({ nonce: pubkey + ':n' + (++c) }),
    signChallenge: async (nonce) => ({ nonce, publickey: pubkey, signature: 'cs:' + pubkey }),
    verifyResponse: async (resp) => ({ ok: true, publickey: resp.publickey }),
    addContact: async () => ({ publickey: pubkey }),
    listContacts: async () => [],
    setRating: async () => ({})
  }
}

/** Espera a que se vacíe la cola de microtasks/macrotasks unas cuantas veces. */
export async function tick (n = 12) { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 3)) }
