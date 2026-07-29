// Lobby: capa de descubrimiento + matchmaking sobre los canales del proxy.
// Crea/lista/une salas de un juego, hace partida rápida (quickMatch) filtrando
// por reputación, e invita contactos por pubkey (cola offline).

import { Emitter, normalizeSeats } from './util.js'
import { K, envelope, discoveryChannel, discoveryChannels } from './protocol.js'
import { Transport } from './transport.js'
import { Room, STATUS } from './room.js'
import { createRepGate, rankRooms } from './reputation.js'

export class Lobby extends Emitter {
  constructor ({ transport, gameId, config }) {
    super()
    this.transport = transport
    this.gameId = gameId
    this.config = config
    this.identity = config.identity || null
    this.reputation = config.reputation || null
    this.myPubkey = (this.identity && this.identity.me && this.identity.me.publickey) || null
    this._gate = createRepGate(this.reputation, config.matchmaking || {})
    this._rooms = new Set()
    this._infoCollector = null
    this._wire()
  }

  _wire () {
    this.transport.subscribe(this.gameId, (from, env) => {
      if (env.k === K.INFO) { if (this._infoCollector) this._infoCollector(from, env.d && env.d.summary) }
      else if (env.k === K.INVITE) this.emit('invite', { from, ...(env.d || {}) })
    })
    // Hay un canal de descubrimiento POR NODO (ver protocol.js): el
    // descubrimiento no tiene dueño natural, así que en vez de designar un nodo
    // árbitro se publica en el propio y se lee de todos.
    const esDescubrimiento = (channel) => this._discoveryChannels().includes(channel)
    // Descubrimiento en vivo: requiere observar el canal (watch) para recibir
    // estos eventos sin publicarnos como sala. Si el proxy no soporta watch,
    // _watchDiscovery degrada a no-op y la app sigue con su polling de respaldo.
    this.transport.on('channel_joined', (channel, token) => { if (esDescubrimiento(channel) && token !== this.transport.token) this.emit('rooms-changed', { type: 'joined', token }) })
    this.transport.on('channel_left', (channel, token) => { if (esDescubrimiento(channel)) this.emit('rooms-changed', { type: 'left', token }) })
    this.transport.on('peer_disconnected', (token, channel) => { if (!channel || esDescubrimiento(channel)) this.emit('rooms-changed', { type: 'left', token }) })
    this.transport.on('reconnect', () => this._watchDiscovery())
    this._watchDiscovery()
  }

  /** Los nodos que conoce el proxio al que estamos conectados (él incluido). */
  _knownNodes () {
    const t = this.transport
    return (t && (t.knownNodes || (t.client && t.client.knownNodes))) || []
  }

  /** Un canal de descubrimiento por nodo conocido. */
  _discoveryChannels () {
    return discoveryChannels(this.gameId, this._knownNodes())
  }

  /** El canal donde ANUNCIAMOS: el del proxio al que estamos conectados. */
  _myDiscoveryChannel () {
    const t = this.transport
    return discoveryChannel(this.gameId, (t && (t.node || (t.client && t.client.node))) || null)
  }

  // Observar los canales de descubrimiento para recibir altas/bajas de salas en
  // vivo (proxy ≥ 0.6.2). Fire-and-forget: no bloquea ni rompe si no está
  // soportado. Son N canales, uno por nodo conocido — hoy dos.
  _watchDiscovery () {
    for (const ch of this._discoveryChannels()) {
      try { this.transport.watch(ch) } catch (_) {}
    }
  }

  // ── Crear / unir ────────────────────────────────────────────────

  /** Crear una sala (sos host). */
  async createRoom (opts = {}) {
    await this.transport.connect()
    const room = new Room({ transport: this.transport, gameId: this.gameId, roomId: this.transport.token, role: 'host', config: this._roomConfig(opts) })
    this._track(room)
    await room._startAsHost()
    return room
  }

  /** Unirse a una sala existente por su roomId (== token del host). */
  async joinRoom (roomId, opts = {}) {
    await this.transport.connect()
    const room = new Room({ transport: this.transport, gameId: this.gameId, roomId, role: 'guest', config: this._roomConfig(opts) })
    this._track(room)
    await room._joinAsGuest()
    return room
  }

  // ── Descubrimiento ──────────────────────────────────────────────

  /**
   * Lista salas abiertas: enumera el canal de descubrimiento y pide un resumen
   * (INFO) a cada host; enriquece y ordena por reputación/contactos.
   * @param {object} [opts]
   * @param {number} [opts.timeout=1500] ventana para recolectar respuestas INFO
   * @param {boolean} [opts.enrich=true] añadir reputación + flag de contacto y ordenar
   */
  async listRooms (opts = {}) {
    await this.transport.connect()
    const timeout = opts.timeout || 1500
    // Se pregunta en CADA nodo y se mezcla. Un nodo que no conteste no rompe la
    // lista: se ven las salas de los demás, que es justo lo que se gana al no
    // tener un nodo árbitro.
    const listas = await Promise.all(this._discoveryChannels().map(
      (ch) => this.transport.list(ch).catch(() => [])
    ))
    const tokens = [...new Set(listas.flat())]
    const others = tokens.filter(t => t && t !== this.transport.token)
    const summaries = await this._gatherInfo(others, timeout)
    if (opts.enrich === false) return summaries
    const contacts = await this._contactSet()
    return rankRooms(summaries, { reputation: this.reputation, contacts, preferContacts: (this.config.matchmaking || {}).preferContacts !== false })
  }

  _gatherInfo (tokens, timeout) {
    return new Promise((resolve) => {
      const got = new Map()
      let timer = null
      const done = () => { if (timer) clearTimeout(timer); this._infoCollector = null; resolve([...got.values()]) }
      if (!tokens.length) return done()
      this._infoCollector = (from, summary) => { if (summary) got.set(from, summary); if (got.size >= tokens.length) done() }
      for (const t of tokens) this._sendTo(t, K.INFO_REQUEST, {})
      timer = setTimeout(done, timeout)
      if (timer.unref) timer.unref()
    })
  }

  // ── Matchmaking ─────────────────────────────────────────────────

  /**
   * Partida rápida: une la mejor sala compatible (con asiento libre, esperando y
   * que pase el gate de reputación); si no hay, crea una y espera oponente.
   * Devuelve el Room (mirá room.isHost). Para auto-sentarte dejá autoSeat=true.
   */
  async quickMatch (opts = {}) {
    const rooms = await this.listRooms({ timeout: opts.timeout || 1500 })
    for (const r of rooms) {
      if (r.status !== STATUS.WAITING || !(r.openSeats > 0)) continue
      const verdict = await this._gate(r.hostPubkey)
      if (!verdict.ok) continue
      const room = await this.joinRoom(r.roomId, opts)
      if (opts.autoSeat !== false) this._autoSeat(room, opts.seat)
      return room
    }
    const room = await this.createRoom(opts)
    if (opts.autoSeat !== false) room.takeSeat(opts.seat)
    return room
  }

  // Toma asiento; el host encola la intención hasta verificar (pendingSeat), así
  // que con un envío basta. Reintenta acotado sólo si seguimos sin asiento.
  _autoSeat (room, seat) {
    if (room.mySeat) return
    room.takeSeat(seat)
    let tries = 0
    const off = room.on('update', () => {
      if (room.mySeat || tries >= 3) { off(); return }
      tries++
      room.takeSeat(seat)
    })
  }

  // ── Invitaciones / contactos ────────────────────────────────────

  /** Invitar a un contacto (por pubkey) a una sala. Usa la cola offline 24 h. */
  inviteContact (pubkey, { roomId, name } = {}) {
    const rid = roomId || this.transport.token
    const env = envelope(this.gameId, rid, K.INVITE, { roomId: rid, name: name || null, from: this.myPubkey, fromName: (this.identity && this.identity.me && this.identity.me.nickname) || null })
    this.transport.sendByPubkey(pubkey, env)
  }

  /** Contactos del vault (compartidos entre apps del ecosistema). */
  async listContacts () {
    if (!this.identity || !this.identity.listContacts) return []
    try { return await this.identity.listContacts() } catch (_) { return [] }
  }

  async _contactSet () {
    const list = await this.listContacts()
    return new Set(list.map(c => c.publickey).filter(Boolean))
  }

  /** Reputación ponderada de una pubkey (para badges en la UI del lobby). */
  async reputationOf (pubkey) {
    if (!this.reputation) return null
    try { return await this.reputation.reputationOf(pubkey) } catch (_) { return null }
  }

  // ── Limpieza ────────────────────────────────────────────────────

  /** Salas activas creadas/unidas por este lobby. */
  get rooms () { return [...this._rooms] }

  async destroy () {
    for (const room of this._rooms) { try { await room.leave() } catch (_) {} }
    this._rooms.clear()
    this.removeAllListeners()
  }

  // ── Internos ────────────────────────────────────────────────────

  _track (room) { this._rooms.add(room); room.on('left', () => this._rooms.delete(room)) }

  _roomConfig (opts) {
    return {
      seats: this.config.seats,
      engineSpec: this.config.engineSpec || null,
      allowSpectators: this.config.allowSpectators !== false,
      maxSpectators: this.config.maxSpectators ?? 50,
      start: this.config.start || 'ready',
      onSeatVacated: this.config.onSeatVacated || 'pause',
      onHostLost: this.config.onHostLost || 'end',
      disconnectGraceMs: this.config.disconnectGraceMs ?? 45000,
      requireVerify: this.config.requireVerify !== false,
      gate: this._gate,
      identity: this.identity,
      reputation: this.reputation,
      name: opts.name || null,
      playerName: opts.playerName || this.config.playerName || null,
      seed: opts.seed ?? this.config.seed,
      // Indicador derivado a co-firmar al terminar (default ELO, scope=gameId).
      resultIndicator: this.config.resultIndicator || 'elo',
      resultScope: this.config.resultScope || this.gameId
    }
  }

  _sendTo (token, kind, data) { this.transport.send(token, envelope(this.gameId, token, kind, data)) }
}

/**
 * Punto de entrada principal: crea (si hace falta) el transporte, lo conecta e
 * identifica con el vault, y devuelve un Lobby listo para el juego dado.
 *
 * @param {object} opts
 * @param {string} opts.gameId  identificador del juego (namespace de canales)
 * @param {Array|object} opts.seats  ['white','black'] o { min, max }
 * @param {object} [opts.engine]  spec del motor de turnos { initialState, reducer, view?, isOver? }
 * @param {object} [opts.identity]  instancia de Identity ya conectada (si no, se conecta sola)
 * @param {object} [opts.reputation]  instancia de createVaultReputation
 * @param {object} [opts.proxy]  cliente proxy ya creado (reuso de conexión)
 * @param {string} [opts.url]  URL del proxy
 * @param {string} [opts.start='ready']  'ready' | 'full' | 'manual'
 * @param {string} [opts.onSeatVacated='pause']  'pause' | 'forfeit' | 'fill'
 * @param {object} [opts.matchmaking]  { requireVouched, minReputation, preferContacts }
 * @returns {Promise<Lobby>}
 */
export async function createLobby (opts = {}) {
  if (!opts.gameId) throw new Error('[lobby] createLobby: falta gameId')
  const transport = opts.transport || new Transport({ proxy: opts.proxy, identity: opts.identity, url: opts.url })
  await transport.connect()
  const config = {
    seats: normalizeSeats(opts.seats || { min: 2, max: 2 }),
    engineSpec: opts.engine || null,
    allowSpectators: opts.allowSpectators,
    maxSpectators: opts.maxSpectators,
    start: opts.start,
    onSeatVacated: opts.onSeatVacated,
    onHostLost: opts.onHostLost,
    disconnectGraceMs: opts.disconnectGraceMs,
    requireVerify: opts.requireVerify,
    identity: transport.identity || opts.identity || null,
    reputation: opts.reputation || null,
    matchmaking: opts.matchmaking || {},
    playerName: opts.playerName || null,
    seed: opts.seed,
    resultIndicator: opts.resultIndicator || 'elo',
    resultScope: opts.resultScope || null
  }
  return new Lobby({ transport, gameId: opts.gameId, config })
}
