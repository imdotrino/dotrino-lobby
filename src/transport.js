// Transporte de lobby: una sola conexión al proxy Dotrino, reutilizable por
// todas las salas/juegos de la app. Encapsula connect + identify (firmado por el
// vault), canales, envío y el demux de mensajes namespaced por gameId.
//
// NO abre una conexión nueva si ya hay una: usa el singleton del proxy-client,
// igual que el messenger. La identidad de red coincide con la de firma (identify
// con sobre firmado por id.signData), lo que habilita la cola offline.

import { Emitter, clock } from './util.js'
import { parseEnvelope } from './protocol.js'

let _defaultGetClient = null
let _defaultIdentityConnect = null

// Carga perezosa de los paquetes del ecosistema (peer deps). Permite testear con
// transportes inyectados sin requerir los paquetes instalados.
async function loadProxyFactory () {
  if (_defaultGetClient) return _defaultGetClient
  const mod = await import('@dotrino/proxy-client')
  _defaultGetClient = mod.getWebSocketProxyClient
  return _defaultGetClient
}
async function loadIdentity () {
  if (_defaultIdentityConnect) return _defaultIdentityConnect
  const mod = await import('@dotrino/identity')
  _defaultIdentityConnect = mod.Identity.connect.bind(mod.Identity)
  return _defaultIdentityConnect
}

export class Transport extends Emitter {
  /**
   * @param {object} opts
   * @param {object} [opts.proxy]    cliente proxy ya creado (si no, se usa el singleton)
   * @param {object} [opts.identity] instancia de Identity ya conectada (para identify/firmas)
   * @param {string} [opts.url]      URL del proxy
   */
  constructor (opts = {}) {
    super()
    this.proxy = opts.proxy || null
    this.identity = opts.identity || null
    this.url = opts.url || null
    this._ready = false
    this._wired = false
    this._connecting = null
    this._subs = new Map() // gameId → Set<fn(from, env, meta)>
  }

  get token () { return this.proxy ? this.proxy.token : null }
  /** Id del proxio al que estamos conectados (12 chars, derivado de su llave). */
  get node () { return this.proxy ? (this.proxy.node || null) : null }
  /** Ese proxio + los que conoce. Es a quiénes se les pregunta por salas. */
  get knownNodes () { return (this.proxy && this.proxy.knownNodes) || [] }
  get isReady () { return this._ready && !!this.token }

  /** Conecta (si hace falta) e identifica con el vault. Idempotente. */
  async connect () {
    if (this.isReady) return this.token
    if (this._connecting) return this._connecting
    this._connecting = (async () => {
      if (!this.proxy) {
        const getClient = await loadProxyFactory()
        this.proxy = getClient(this.url ? { url: this.url } : undefined)
      }
      if (this.url && this.proxy.updateConfig) this.proxy.updateConfig({ url: this.url })
      if (!this.identity) {
        try { const connect = await loadIdentity(); this.identity = await connect() } catch (_) { this.identity = null }
      }
      this._wire()
      await this.proxy.connect()
      await this._identify()
      this._ready = true
      this.emit('ready', this.token)
      return this.token
    })()
    try { return await this._connecting } finally { this._connecting = null }
  }

  _wire () {
    if (this._wired) return
    this._wired = true

    // Reconexión: el proxy reasigna token; reidentificamos y avisamos para que
    // las salas vuelvan a anunciarse / re-saludar.
    let firstToken = false
    this.proxy.on('token', async () => {
      if (!firstToken) { firstToken = true; return } // el primer token lo maneja connect()
      try { await this._identify() } catch (e) { console.warn('[lobby] re-identify falló:', e) }
      this.emit('reconnect', this.token)
      this.emit('ready', this.token)
    })

    this.proxy.on('message', (from, payload, meta) => {
      const env = parseEnvelope(payload)
      if (!env) return
      const subs = this._subs.get(env.g)
      if (!subs || !subs.size) return
      for (const fn of [...subs]) {
        try { fn(from, env, meta) } catch (e) { console.error('[lobby] sub handler error:', e) }
      }
    })

    // Eventos de presencia (no namespaced; las salas filtran por canal).
    this.proxy.on('peer_disconnected', (token, channel) => this.emit('peer_disconnected', token, channel || null))
    this.proxy.on('channel_joined', (channel, token) => this.emit('channel_joined', channel, token))
    this.proxy.on('channel_left', (channel, token) => this.emit('channel_left', channel, token))
    this.proxy.on('disconnect', (d) => this.emit('disconnect', d))
  }

  async _identify () {
    if (!this.identity || !this.proxy || !this.proxy.token) return
    const me = this.identity.me
    const publickey = me && me.publickey
    if (!publickey) return
    const data = { op: 'identify', publickey, token: this.proxy.token, ts: clock.now() }
    const signed = await this.identity.signData(data)
    const signature = typeof signed === 'string' ? signed : signed.signature
    await this.proxy.identify({ data, signature })
  }

  /** Demultiplexor: registra un handler para un gameId. Devuelve desuscriptor. */
  subscribe (gameId, fn) {
    let set = this._subs.get(gameId)
    if (!set) { set = new Set(); this._subs.set(gameId, set) }
    set.add(fn)
    return () => { const s = this._subs.get(gameId); if (s) s.delete(fn) }
  }

  /** Envío directo por token (intenta WebRTC, cae a proxy). */
  send (to, env) { this.proxy.send(to, env) }

  /** Envío por pubkey estable (cola offline 24 h). Para invitaciones a contactos. */
  sendByPubkey (pubkeys, env) { this.proxy.sendByPubkey(pubkeys, env) }

  // ── Canales ────────────────────────────────────────────────────
  publish (channel, extra) { return this.proxy.publish(channel, extra) }
  unpublish (channel) { return this.proxy.unpublish(channel) }
  list (channel) { return this.proxy.list(channel) }
  listChannels (options) { return this.proxy.listChannels(options) }
  channelCount (channel) { return this.proxy.channelCount(channel) }

  // Observación read-only de un canal (proxy ≥ 0.6.2). Degrada elegante: si el
  // cliente/proxy no lo soporta o no responde, resuelve sin colgar (la app cae a
  // polling). Nunca bloquea ni rechaza hacia arriba.
  watch (channel) {
    if (!this.proxy || typeof this.proxy.watch !== 'function') return Promise.resolve(null)
    return Promise.race([
      this.proxy.watch(channel).catch(() => null),
      new Promise(res => { const t = setTimeout(() => res(null), 4000); if (t.unref) t.unref() })
    ])
  }

  unwatch (channel) {
    if (!this.proxy || typeof this.proxy.unwatch !== 'function') return Promise.resolve(null)
    return this.proxy.unwatch(channel).catch(() => null)
  }

  // ── WebRTC (opcional, para partidas de baja latencia) ─────────
  connectWebRTC (token) { return this.proxy.connectWebRTC(token) }
  isWebRTCOpen (token) { return this.proxy.isWebRTCOpen(token) }
}
