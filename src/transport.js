// Transporte de lobby: una sola conexión al proxy Dotrino, reutilizable por
// todas las salas/juegos de la app. Encapsula connect + identify (firmado por el
// vault), canales, envío y el demux de mensajes namespaced por gameId.
//
// NO abre una conexión nueva si ya hay una: usa el singleton del proxy-client,
// igual que el messenger. La identidad de red coincide con la de firma (identify
// con sobre firmado por id.signData), lo que habilita la cola offline.
//
// ─────────────────────────────────────────────────────────────────────────────
// TODO LO DIRIGIDO VA SELLADO (CONVENCIONES §4.1)
//
// El proxio NO cifra: `send`/`sendByPubkey` serializan el payload y lo mandan tal
// cual, así que el chat, las jugadas y los nombres de los jugadores los leía quien
// opera el proxio — y el de producción corre en un VPS alquilado.
//
// Por eso esta clase NO EXPONE NINGÚN ENVÍO EN CLARO. Solo hay tres salidas:
//   · `sendSealedTo(token, env, peerPubkey)` — lo de la sala, por token
//   · `sendSealedByPubkey(pubkeys, env)`     — invitaciones y re-clave, por pubkey
//   · `sendIntro(token, env)`                — la presentación, que solo lleva una
//     publickey y no se puede sellar todavía (ver INTRO_KINDS en protocol.js)
//
// Y de ENTRADA se tira todo lo que no venga sellado salvo esos dos mensajes de
// presentación: sellar solo de salida no sirve de nada, porque quien acepta texto
// en claro se salta el sellado entero y cualquiera podría colar una jugada falsa.
// ─────────────────────────────────────────────────────────────────────────────

import { Emitter } from './util.js'
import { parseEnvelope, isIntroKind } from './protocol.js'

/**
 * La MARCA de nuestros sobres (`identitySealing`). Las dos puntas son esta misma
 * librería, así que es fija: cambiarla es dejar de abrir lo de la versión anterior.
 */
const SEAL_APP = 'dotrino-lobby'

let _proxyModule = null
let _defaultIdentityConnect = null

// Carga perezosa de los paquetes del ecosistema (peer deps). Permite testear con
// transportes inyectados sin requerir los paquetes instalados.
async function loadProxyModule () {
  if (_proxyModule) return _proxyModule
  _proxyModule = await import('@dotrino/proxy-client')
  return _proxyModule
}
async function loadIdentity () {
  if (_defaultIdentityConnect) return _defaultIdentityConnect
  const mod = await import('@dotrino/identity')
  _defaultIdentityConnect = mod.Identity.connect.bind(mod.Identity)
  return _defaultIdentityConnect
}

/** Error con `code`: los fallos se comprueban por el código, nunca por la frase. */
function errorCon (message, code) {
  const e = /** @type {Error & { code: string }} */ (new Error(message))
  e.code = code
  return e
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
    this._myEncPub = null
    this._subs = new Map() // gameId → Set<fn(from, env, meta)>
  }

  get token () { return this.proxy ? this.proxy.token : null }
  /** Id del proxio al que estamos conectados (12 chars, derivado de su llave). */
  get node () { return this.proxy ? (this.proxy.node || null) : null }
  /** Ese proxio + los que conoce. Es a quiénes se les pregunta por salas. */
  get knownNodes () { return (this.proxy && this.proxy.knownNodes) || [] }
  get isReady () { return this._ready && !!this.token }
  /** Mi llave de cifrado (la pública): con ella me sellan los demás. */
  get myEncPub () { return this._myEncPub }

  /** Conecta (si hace falta) e identifica con el vault. Idempotente. */
  async connect () {
    if (this.isReady) return this.token
    if (this._connecting) return this._connecting
    this._connecting = (async () => {
      const mod = await loadProxyModule()
      if (!this.proxy) {
        this.proxy = mod.getWebSocketProxyClient(this.url ? { url: this.url } : undefined)
      }
      if (this.url && this.proxy.updateConfig) this.proxy.updateConfig({ url: this.url })
      if (!this.identity) {
        const connect = await loadIdentity()
        this.identity = await connect()
      }
      // SIN IDENTIDAD NO SE PUEDE SELLAR, y sin sellar no se manda: se para y se dice.
      // Antes se degradaba a `identity = null` y la sala seguía funcionando; eso hoy
      // significaría mandar el chat y las jugadas en claro, que es justo lo que esto
      // viene a cerrar.
      if (!this.identity || !this.identity.me || !this.identity.me.publickey) {
        throw errorCon('[lobby] no identity: nothing can be sealed, so nothing is sent', 'no-identity')
      }
      await this._wireSealing(mod)
      this._wire()
      await this.proxy.connect()
      await this._identify()
      this._ready = true
      this.emit('ready', this.token)
      return this.token
    })()
    try { return await this._connecting } finally { this._connecting = null }
  }

  /**
   * EL PUENTE DE LA BÓVEDA. En el navegador la privada de cifrado no está en la app:
   * vive dentro del iframe y no sale. `identitySealing` (pilar ≥ 0.21.0) delega sellar
   * y abrir en `identity.encrypt`/`decrypt`, que es la MISMA cripto — no es cripto
   * nueva, y por eso no se escribe aquí.
   *
   * La llave que se anuncia es la del PERFIL EN ESTE APARATO (`getEncryptionPubkey`),
   * que es durable: una llave de sesión se perdería en cada recarga y dejaría sin abrir
   * lo que alguien nos hubiera sellado mientras (las invitaciones esperan 24 h).
   */
  async _wireSealing (mod) {
    if (this.proxy.myEncPub && this.proxy.sealing) { this._myEncPub = this.proxy.myEncPub; return }
    if (typeof mod.identitySealing !== 'function') {
      throw errorCon('[lobby] @dotrino/proxy-client >= 0.21.0 required (identitySealing)', 'no-sealing-support')
    }
    if (typeof this.identity.getEncryptionPubkey !== 'function') {
      throw errorCon('[lobby] this identity exposes no getEncryptionPubkey()', 'no-encpub')
    }
    const encPub = await this.identity.getEncryptionPubkey()
    if (!encPub) throw errorCon('[lobby] the vault returned no encryption key', 'no-encpub')
    this._myEncPub = encPub
    this.proxy.updateConfig({
      myEncPub: encPub,
      sealing: mod.identitySealing(this.identity, { app: SEAL_APP })
    })
  }

  _wire () {
    if (this._wired) return
    this._wired = true

    // Reconexión: el proxy reasigna token; reidentificamos y avisamos para que
    // las salas vuelvan a anunciarse / re-saludar.
    let firstToken = false
    this.proxy.on('token', async () => {
      if (!firstToken) { firstToken = true; return } // el primer token lo maneja connect()
      try { await this._identify() } catch (e) { console.warn('[lobby] re-identify failed:', e) }
      this.emit('reconnect', this.token)
      this.emit('ready', this.token)
    })

    this.proxy.on('message', (from, payload, meta) => {
      const env = parseEnvelope(payload)
      if (!env) return
      // LO QUE NO VIENE SELLADO SE TIRA. Las dos únicas excepciones son los mensajes
      // de presentación, que solo llevan una publickey (ver INTRO_KINDS): aceptar
      // texto en claro sería dejar que cualquiera cuele una jugada o un chat falso
      // sin haber leído nunca nada.
      if (!(meta && meta.sealed) && !isIntroKind(env.k)) {
        console.warn(`[lobby] dropped an unsealed message (kind=${env.k}) from ${from}`)
        return
      }
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
    const sign = (d) => this.identity.signData(d)
    // El sobre lo arma el pilar (`identifyAs`), que le pone el destinatario.
    await this.proxy.identifyAs({ publickey, sign })
    // Y SE ESPERA AL ANUNCIO DE LA LLAVE. `identify` lo lanza por detrás y sin
    // bloquear, que para casi todo está bien; aquí no: el primer mensaje de una sala
    // sale inmediatamente después, y quien lo reciba preguntará por nuestra llave. Si
    // el anuncio todavía va firmándose en la bóveda, esa pregunta vuelve `no-encpub` y
    // el que llega se queda fuera sin saber por qué.
    if (this._myEncPub) {
      await this.proxy.announceEncPub({ publickey, encPub: this._myEncPub, sign })
    }
  }

  /** Demultiplexor: registra un handler para un gameId. Devuelve desuscriptor. */
  subscribe (gameId, fn) {
    let set = this._subs.get(gameId)
    if (!set) { set = new Set(); this._subs.set(gameId, set) }
    set.add(fn)
    return () => { const s = this._subs.get(gameId); if (s) s.delete(fn) }
  }

  // ── Envío ──────────────────────────────────────────────────────

  /**
   * Envío SELLADO por token, que es como hablan los de una sala (y lo único que puede
   * subir a WebRTC). El token es una dirección del proxio y no dice de quién es: quien
   * sabe qué identidad hay detrás es la sala —lo aprendió del saludo, de la lista o de
   * la invitación— y por eso se pasa aquí.
   *
   * Si no se puede sellar, LANZA: no hay camino de vuelta al texto en claro.
   * @param {string} token
   * @param {object} env sobre de protocol.js
   * @param {string} peerPubkey publickey de quien está detrás del token
   */
  sendSealedTo (token, env, peerPubkey) {
    if (!peerPubkey) {
      return Promise.reject(errorCon('[lobby] sendSealedTo: unknown identity behind that token', 'unknown-peer'))
    }
    return this.proxy.sendSealedTo(token, env, { peerPubkey })
  }

  /** Envío SELLADO por pubkey estable (cola offline 24 h). Invitaciones y re-clave. */
  sendSealedByPubkey (pubkeys, env) {
    return this.proxy.sendSealed(pubkeys, env)
  }

  /**
   * LA PRESENTACIÓN, el único envío que sale sin sellar. Solo acepta los dos mensajes
   * de INTRO_KINDS, que llevan una publickey y nada más — el mismo dato que el proxio
   * ya tiene de nosotros desde `identify`.
   */
  sendIntro (token, env) {
    if (!isIntroKind(env && env.k)) {
      throw errorCon(`[lobby] sendIntro refuses to send "${env && env.k}" in the clear`, 'unsealed')
    }
    this.proxy.send(token, env)
  }

  // ── Canales ────────────────────────────────────────────────────
  // Son PÚBLICOS por diseño (§4.1): publicar/listar salas no se sella, y aquí no
  // viaja nada del usuario — solo el nombre del canal y quién está en él.
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
