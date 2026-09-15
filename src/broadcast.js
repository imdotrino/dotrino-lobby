// EMISIÓN: UNO EMITE, LOS DEMÁS MIRAN.
//
// Para lo que se enseña en vivo y nadie más toca —un torneo, un marcador—: el emisor
// publica su estado y quien tiene el enlace lo recibe, SELLADO a él y FIRMADO por el
// emisor.
//
// No es una sala (room.js): no hay asientos, ni turnos, ni chat, ni lista de quién mira.
// Lo que la separa de una sala son tres cosas que una sala no da:
//
//   · ENTRA SOLO QUIEN TIENE LA CLAVE. El nombre del canal se puede listar en el proxio,
//     y eso da un token y nada más: sin el secreto del enlace, el emisor contesta que no.
//
//   · EL ENLACE NO MUERE CON UNA RECARGA. El id no es el token del emisor, que cambia en
//     cada conexión: es una clave estable, y el emisor la vuelve a anunciar al volver.
//
//   · LO QUE LLEGA SE COMPRUEBA. Cada estado va firmado por la identidad del emisor, y
//     quien mira lo verifica contra la llave que trae el enlace. Sellar protege de que
//     alguien LEA; firmar, de que alguien lo INVENTE — cualquiera puede sellarle a
//     cualquiera, porque las llaves de cifrado son públicas, y eso incluye al proxio.
//
// Quien mira no se publica en el canal: lo OBSERVA (`watch`), así que no sale en la
// lista y nadie sabe quién más mira. El emisor tampoco guarda nombres: solo tokens.
//
// Lo que NO hace, y se dice: guardar el estado fuera del emisor. Si el emisor se va,
// quien mira conserva lo último que le llegó y lo vuelve a encontrar cuando vuelve.

import { Emitter, clock, samePubkey } from './util.js'
import { K, envelope, broadcastChannel, isNodeId } from './protocol.js'

const REFRESH_MS = 60 * 1000 // quien mira se vuelve a anunciar cada minuto
const WATCHER_TTL_MS = 150 * 1000 // el emisor olvida a quien lleva 2,5 min sin anunciarse
const RETRY_MS = 3000 // hasta la primera respuesta, se vuelve a pedir
const RETRIES = 5
const REPUBLISH_MS = 10 * 60 * 1000 // las entradas de canal del proxio caducan a los 20 min
const DEFAULT_MAX_VIEWERS = 50

const B64URL = /^[A-Za-z0-9_-]+$/

function errorCon (message, code) {
  const e = /** @type {Error & { code: string }} */ (new Error(message))
  e.code = code
  return e
}

function randomB64url (bytes) {
  const b = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(b)
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Una referencia nueva para emitir.
 *   · `key` nombra el canal. Lleva delante el nodo del proxio donde vive, igual que un
 *     token; sin nodo empieza por `_`, que no puede confundirse con un id de nodo.
 *   · `secret` prueba que se tiene el enlace. No sale nunca en claro: viaja sellado.
 * @param {string|null} [node] id del proxio (`transport.node`)
 */
export function newBroadcastRef (node = null) {
  return { key: (isNodeId(node) ? node : '_') + randomB64url(16), secret: randomB64url(16) }
}

/**
 * Lo que va en el enlace (`#fragment`, que no llega a ningún servidor):
 * `clave.secreto.x.y`. La llave del emisor va como sus coordenadas P-256, que es lo que
 * la identifica.
 * @param {{ key?: string, secret?: string, hostPubkey?: string | { crv?: string, x?: string, y?: string } }} [ref]
 */
export function encodeBroadcastRef ({ key, secret, hostPubkey } = {}) {
  let jwk = null
  try { jwk = typeof hostPubkey === 'string' ? JSON.parse(hostPubkey) : hostPubkey } catch (_) { /* abajo */ }
  const parts = [key, secret, jwk && jwk.crv === 'P-256' ? jwk.x : null, jwk && jwk.crv === 'P-256' ? jwk.y : null]
  if (!parts.every(p => typeof p === 'string' && B64URL.test(p))) throw errorCon('[lobby] incomplete broadcast ref', 'bad-ref')
  return parts.join('.')
}

/** Lo contrario de `encodeBroadcastRef`. Lanza `bad-ref` si el texto no tiene esa forma. */
export function decodeBroadcastRef (text) {
  const parts = String(text || '').split('.')
  if (parts.length !== 4 || !parts.every(p => p && B64URL.test(p))) throw errorCon('[lobby] malformed broadcast ref', 'bad-ref')
  const [key, secret, x, y] = parts
  return { key, secret, hostPubkey: JSON.stringify({ crv: 'P-256', kty: 'EC', x, y }) }
}

/**
 * Una emisión. Eventos:
 *   · 'state'   (state, { at, seq })  quien mira: llegó un estado nuevo y verificado
 *   · 'status'  ({ status, reason })  'connecting' | 'live' | 'host-offline' | 'denied' | 'closed'
 *   · 'viewers' (n)                   el emisor: cambió cuántos miran
 *   · 'event'   ({ event, data })     'seal-failed' | 'forged'
 *   · 'closed'
 */
export class Broadcast extends Emitter {
  /**
   * @param {{ transport: any, gameId: string, role: 'host' | 'viewer', ref: { key: string, secret: string, hostPubkey?: string }, identity: any, maxViewers?: number }} opts
   */
  constructor ({ transport, gameId, role, ref, identity, maxViewers }) {
    super()
    this.transport = transport
    this.gameId = gameId
    this.role = role // 'host' | 'viewer'
    this.key = ref.key
    this._secret = ref.secret
    this.identity = identity
    this.hostPubkey = role === 'host' ? identity.me.publickey : ref.hostPubkey
    this.maxViewers = maxViewers ?? DEFAULT_MAX_VIEWERS
    this.channel = broadcastChannel(gameId, ref.key)
    this.status = 'connecting'
    this.state = null
    this.at = 0

    // Emisor
    this._seq = 0
    this._latest = null // { payload, signature }
    this._watchers = new Map() // token → última vez que se anunció

    // Quien mira
    this._hostToken = null
    this._hostPeerPubkey = null // la llave tal como la dio el saludo: con esa se sella
    this._awaiting = false

    this._timers = []
    this._unsub = []
    this._closed = false
  }

  get isHost () { return this.role === 'host' }
  /** Lo que lleva el enlace: clave, secreto y la llave del emisor (ver `encodeBroadcastRef`). */
  get ref () { return { key: this.key, secret: this._secret, hostPubkey: this.hostPubkey } }
  /** Cuántos miran ahora (solo el emisor lo sabe). */
  get viewers () { return this._watchers.size }

  // ── Arranque ───────────────────────────────────────────────────

  async _startAsHost () {
    this._wire()
    await this.transport.publish(this.channel)
    this._every(REPUBLISH_MS, () => this.transport.publish(this.channel).catch(e => this._warn('republish', e)))
    this._every(REFRESH_MS, () => this._pruneWatchers())
    this._setStatus('live')
    return this
  }

  async _startAsViewer () {
    this._wire()
    this._every(REFRESH_MS, () => this._announce())
    await this._lookForHost()
    return this
  }

  _wire () {
    this._unsub.push(this.transport.subscribe(this.gameId, (from, env) => {
      if (env.r !== this.key) return
      if (this.isHost) this._onHostMessage(from, env)
      else this._onViewerMessage(from, env).catch(e => console.error('[lobby] broadcast message handler failed:', e))
    }))
    this._unsub.push(
      this.transport.on('channel_joined', (channel, token) => {
        if (channel === this.channel && !this.isHost) this._checkHost([token])
      }),
      this.transport.on('channel_left', (channel, token) => { if (channel === this.channel) this._gone(token) }),
      this.transport.on('peer_disconnected', (token, channel) => { if (!channel || channel === this.channel) this._gone(token) }),
      this.transport.on('reconnect', () => this._onReconnect())
    )
  }

  // ── Emisor ─────────────────────────────────────────────────────

  /**
   * El estado nuevo. Se firma UNA vez con la identidad del emisor y se sella a cada uno
   * de los que miran. `at` crece siempre, también tras recargar: es lo que usa quien
   * mira para descartar lo viejo o repetido.
   */
  async publish (state) {
    if (!this.isHost) throw errorCon('[lobby] only the host publishes a broadcast', 'not-host')
    if (this._closed) throw errorCon('[lobby] this broadcast is closed', 'closed')
    const payload = { v: 1, g: this.gameId, k: this.key, at: Math.max(clock.now(), this.at + 1), seq: ++this._seq, state }
    const signed = await this.identity.signData(payload)
    if (!signed || typeof signed.signature !== 'string') throw errorCon('[lobby] the identity returned no signature', 'no-signature')
    this.at = payload.at
    this.state = state
    this._latest = { payload, signature: signed.signature }
    for (const token of this._watchers.keys()) this._send(token, K.BCAST, this._latest)
  }

  _onHostMessage (from, env) {
    if (env.k !== K.WATCH) return
    const d = env.d || {}
    if (d.secret !== this._secret) {
      this._send(from, K.BCAST_DENIED, { reason: 'bad-secret' })
      return
    }
    const isNew = !this._watchers.has(from)
    if (isNew && this._watchers.size >= this.maxViewers) {
      this._send(from, K.BCAST_DENIED, { reason: 'full' })
      return
    }
    this._watchers.set(from, clock.now())
    if (isNew) this.emit('viewers', this._watchers.size)
    // Solo lo que le falta: al entrar, o si lo último que tiene es más viejo que lo mío.
    if (this._latest && !(typeof d.at === 'number' && d.at >= this._latest.payload.at)) {
      this._send(from, K.BCAST, this._latest)
    }
  }

  _pruneWatchers () {
    const limit = clock.now() - WATCHER_TTL_MS
    let changed = false
    for (const [token, seen] of this._watchers) {
      if (seen < limit) { this._watchers.delete(token); changed = true }
    }
    if (changed) this.emit('viewers', this._watchers.size)
  }

  // ── Quien mira ─────────────────────────────────────────────────

  async _lookForHost () {
    // `watch` contesta con quién está publicado; si el proxio no lo sabe hacer, `list`.
    const tokens = (await this.transport.watch(this.channel)) || await this.transport.list(this.channel)
    await this._checkHost(tokens)
    if (!this._hostToken && !this._closed) this._setStatus('host-offline')
  }

  /**
   * ¿Alguno de estos tokens es el emisor? Cualquiera puede publicarse en el canal, así
   * que no vale estar ahí: vale que el saludo del transporte diga la llave del enlace.
   */
  async _checkHost (tokens) {
    const mine = this.transport.token
    for (const token of tokens || []) {
      if (!token || token === mine || token === this._hostToken) continue
      let pk
      try {
        pk = await this.transport.peerIdentity(token, { timeout: 2000 })
      } catch (_) {
        continue // no contestó al saludo: no es a quien buscamos, o ya se fue
      }
      if (this._closed) return
      if (samePubkey(pk, this.hostPubkey)) {
        this._hostFound(token, pk)
        return
      }
    }
  }

  _hostFound (token, peerPubkey) {
    this._hostToken = token
    this._hostPeerPubkey = peerPubkey
    this._awaiting = true
    // SALUDAR SIEMPRE, aunque ya se supiera quién es el emisor. El saludo se contesta una
    // vez por token: si reconectamos con token nuevo y el emisor ya nos había contestado,
    // él no sabe de quién es este token y no tendría a quién sellarnos el estado.
    try {
      this.transport.helloTo(token)
    } catch (e) {
      this._warn('hello', e)
    }
    let tries = 0
    const ask = () => {
      if (this._closed || !this._awaiting || this._hostToken !== token || tries++ >= RETRIES) return
      this._announce()
      const t = setTimeout(ask, RETRY_MS)
      if (t.unref) t.unref()
      this._timers.push(t)
    }
    ask()
  }

  /** «Sigo mirando», con el secreto y lo último que tengo. Va sellado al emisor. */
  _announce () {
    if (!this._hostToken) return
    this._send(this._hostToken, K.WATCH, { secret: this._secret, at: this.at || null }, this._hostPeerPubkey)
  }

  async _onViewerMessage (from, env) {
    if (env.k === K.BCAST_DENIED) {
      if (from !== this._hostToken) return
      this._awaiting = false
      this._setStatus('denied', (env.d && env.d.reason) || null)
      return
    }
    if (env.k !== K.BCAST) return
    const d = env.d || {}
    const p = d.payload
    if (!p || p.v !== 1 || p.g !== this.gameId || p.k !== this.key || typeof p.at !== 'number' || typeof d.signature !== 'string') return
    // LO QUE LLEGA SE COMPRUEBA. Da igual por qué token venga —el emisor cambia de token
    // al reconectar—: vale si lo firmó la llave del enlace, y nada más.
    const ok = await this.transport.verifySignature(this.hostPubkey, p, d.signature)
    if (!ok) {
      console.warn(`[lobby] broadcast: dropped a state from ${from} that the host did not sign`)
      this.emit('event', { event: 'forged', data: { from } })
      return
    }
    // Viejo o repetido: un proxio puede volver a entregar lo que ya pasó.
    if (p.at <= this.at || this._closed) return
    this._awaiting = false
    this.at = p.at
    this.state = p.state
    this._setStatus('live')
    this.emit('state', p.state, { at: p.at, seq: p.seq })
  }

  // ── Presencia y reconexión ─────────────────────────────────────

  _gone (token) {
    if (this.isHost) {
      if (this._watchers.delete(token)) this.emit('viewers', this._watchers.size)
      return
    }
    if (token !== this._hostToken) return
    this._hostToken = null
    this._hostPeerPubkey = null
    this._awaiting = false
    this._setStatus('host-offline')
  }

  _onReconnect () {
    if (this._closed) return
    if (this.isHost) {
      this.transport.publish(this.channel).catch(e => this._warn('republish', e))
      return
    }
    this._hostToken = null
    this._lookForHost().catch(e => this._warn('look for host', e))
  }

  /** Dejar de emitir o de mirar. */
  async close () {
    if (this._closed) return
    this._closed = true
    for (const t of this._timers) { clearInterval(t); clearTimeout(t) }
    for (const off of this._unsub) { try { off() } catch (_) {} }
    this._unsub = []
    if (this.isHost) await this.transport.unpublish(this.channel).catch(e => this._warn('unpublish', e))
    else await this.transport.unwatch(this.channel)
    this._setStatus('closed')
    this.emit('closed')
    this.removeAllListeners()
  }

  // ── Auxiliares ─────────────────────────────────────────────────

  _setStatus (status, reason = null) {
    if (this.status === status && !reason) return
    this.status = status
    this.emit('status', { status, reason })
  }

  _every (ms, fn) {
    const t = setInterval(fn, ms)
    if (t.unref) t.unref()
    this._timers.push(t)
  }

  _warn (what, e) {
    console.warn(`[lobby] broadcast: ${what} failed (${(e && e.code) || 'error'}):`, e && e.message)
  }

  /** TODO SALE SELLADO; si no se puede sellar, no sale y se avisa con su `code`. */
  async _send (token, kind, data, peerPubkey) {
    try {
      // A quién sellarle. Si el saludo todavía no dijo de quién es este token, se le
      // pregunta: pasa cuando el otro reconectó con token nuevo y ya conocía mi llave de
      // antes, así que no volvió a saludar.
      const peer = peerPubkey || this.transport.pubkeyOfToken(token) || await this.transport.peerIdentity(token, { timeout: 2000 })
      await this.transport.sendSealedTo(token, envelope(this.gameId, this.key, kind, data), peer)
    } catch (e) {
      const code = (e && e.code) || 'send-failed'
      console.warn(`[lobby] broadcast: sealed ${kind} to ${token} failed (${code}):`, e && e.message)
      this.emit('event', { event: 'seal-failed', data: { kind, code } })
    }
  }
}
