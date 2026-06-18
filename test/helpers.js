// Helpers de test: hub en memoria que emula el proxy (ruteo por token, canales,
// presencia) + identidades falsas. No contiene tests (node --test lo ignora).

import { Emitter } from '../src/util.js'
import { parseEnvelope } from '../src/protocol.js'

export class MockHub {
  constructor () { this.endpoints = new Map(); this.channels = new Map(); this.byPubkey = new Map(); this._n = 0 }

  endpoint (opts = {}) {
    const token = opts.token || ('tk' + (++this._n))
    const ep = new MockTransport(this, token, opts.identity || null)
    this.endpoints.set(token, ep)
    if (opts.identity && opts.identity.me && opts.identity.me.publickey) this.byPubkey.set(opts.identity.me.publickey, token)
    return ep
  }

  route (from, to, env) {
    const tos = Array.isArray(to) ? to : [to]
    for (const t of tos) {
      const ep = this.endpoints.get(t)
      if (!ep || ep._down) continue
      queueMicrotask(() => ep._deliver(from, env))
    }
  }

  routeByPubkey (from, pubkeys, env) {
    const arr = Array.isArray(pubkeys) ? pubkeys : [pubkeys]
    for (const pk of arr) { const t = this.byPubkey.get(pk); if (t) this.route(from, t, env) }
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

export class MockTransport extends Emitter {
  constructor (hub, token, identity) { super(); this.hub = hub; this._token = token; this.identity = identity; this._subs = new Map(); this._down = false }
  get token () { return this._token }
  get isReady () { return !this._down }
  async connect () { return this._token }

  subscribe (gameId, fn) {
    let s = this._subs.get(gameId); if (!s) { s = new Set(); this._subs.set(gameId, s) }
    s.add(fn); return () => { const x = this._subs.get(gameId); if (x) x.delete(fn) }
  }

  _deliver (from, env) {
    const parsed = parseEnvelope(env); if (!parsed) return
    const subs = this._subs.get(parsed.g); if (!subs) return
    for (const fn of [...subs]) { try { fn(from, parsed, { via: 'mock' }) } catch (e) { console.error(e) } }
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

  send (to, env) { this.hub.route(this._token, to, env) }
  sendByPubkey (pubkeys, env) { this.hub.routeByPubkey(this._token, pubkeys, env) }
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
    signData: async (data) => ({ signature: 'sig:' + pubkey + ':' + JSON.stringify(data), publickey: pubkey }),
    makeChallenge: async () => ({ nonce: pubkey + ':n' + (++c) }),
    signChallenge: async (nonce) => ({ nonce, publickey: pubkey, signature: 'cs:' + pubkey }),
    verifyResponse: async (resp) => ({ ok: true, publickey: resp.publickey }),
    addContact: async () => ({ publickey: pubkey }),
    listContacts: async () => [],
    setRating: async () => ({})
  }
}

/** Espera a que se vacíe la cola de microtasks/macrotasks unas cuantas veces. */
export async function tick (n = 6) { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 2)) }
