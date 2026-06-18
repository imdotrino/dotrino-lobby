// Room: una partida concreta con autoridad de host (serverless: el host es uno
// de los jugadores). Encapsula TODO lo que cada juego del ecosistema venía
// reimplementando a mano: asientos, espectadores, presencia, pausa/reconexión
// por pubkey, sincronización autoritativa con resync, verificación de identidad
// del oponente y recibo de partida co-firmado.
//
// Un mismo objeto Room sirve para host y guest (branch por this.role). El host
// muta el estado autoritativo y lo difunde; el guest envía intenciones y refleja
// lo que llega.

import { Emitter, clock, samePubkey } from './util.js'
import { K, envelope, roomChannel, discoveryChannel } from './protocol.js'
import { createEngine } from './engine.js'
import { signReceiptHalf, signEventHalf, eventPayload, ratePlayer as repRatePlayer } from './reputation.js'

export const STATUS = { WAITING: 'waiting', PLAYING: 'playing', PAUSED: 'paused', ENDED: 'ended' }
export const SEAT = { OPEN: 'open', OCCUPIED: 'occupied', DISCONNECTED: 'disconnected' }

export class Room extends Emitter {
  constructor ({ transport, gameId, roomId, role, config }) {
    super()
    this.transport = transport
    this.gameId = gameId
    this.roomId = roomId            // host: == transport.token ; guest: token del host
    this.role = role                // 'host' | 'guest'
    this.config = config
    this.name = config.name || null

    this.identity = config.identity || null
    this.reputation = config.reputation || null
    this.myPubkey = (this.identity && this.identity.me && this.identity.me.publickey) || null
    this.myName = config.playerName || (this.identity && this.identity.me && this.identity.me.nickname) || null

    // Estado público unificado (lo que ven los getters). El host lo deriva de su
    // estado autoritativo; el guest lo recibe por STATE.
    this._public = this._emptyPublic()

    // Estado autoritativo del host (campos de trabajo).
    this.engine = config.engineSpec ? createEngine(config.engineSpec) : null
    this.hostPubkey = role === 'host' ? this.myPubkey : null
    this._seats = {}                // id → { id, pubkey, token, name, ready, status, disconnectAt }
    this._members = new Map()       // token → { pubkey, name, verified, nonce, lastSeen }
    this._status = STATUS.WAITING
    this._result = null
    this._seq = 0
    this._graceTimers = new Map()   // seatId → timeout
    this._receipts = new Map()      // peerPubkey → { a,b,ts,sigA,sigB }
    this._pendingReceiptSig = new Map() // receiptId → mitad pendiente
    this._pendingResults = new Map()    // resultId → resultado a co-firmar (para ELO)

    // Roomids que el host acepta en el campo `r` (incluye el viejo durante una
    // ventana tras reconectar, mientras los guests se re-claven).
    this._acceptedRoomIds = new Set([roomId])
    this._rekeyTimer = null
    this._heartbeat = null

    // Guest
    this._hostToken = role === 'guest' ? roomId : null // a quién le mando (cambia si el host reconecta)
    this._lastSeq = -1
    this._joinTimer = null
    this._joinAttempts = 0
    this._hostLostTimer = null

    this._unsub = []
    if (role === 'host') this._initSeats()
  }

  // ── Getters públicos ───────────────────────────────────────────
  get isHost () { return this.role === 'host' }
  get status () { return this._public.status }
  get result () { return this._public.result }
  get seats () { return this._public.seats }
  get spectators () { return this._public.spectators }
  get game () { return this._public.game }
  get version () { return this._public.version }
  get state () { return this._public }
  get mySeat () {
    // Host: resuelve por su token (siempre lo tiene, con o sin identidad).
    if (this.isHost) {
      const byToken = this._seatIdByToken(this.transport.token)
      if (byToken) return byToken
    }
    const seats = this._public.seats || {}
    if (this.myPubkey) {
      for (const id of Object.keys(seats)) {
        if (seats[id] && samePubkey(seats[id].pubkey, this.myPubkey)) return id
      }
    }
    // Sin identidad: el host nos marca el asiento propio en el snapshot personalizado.
    return this._public.mySeatId || null
  }

  _emptyPublic () {
    return { roomId: this.roomId, gameId: this.gameId, name: this.name, hostPubkey: null, status: STATUS.WAITING, seats: {}, spectators: [], result: null, game: null, version: 0 }
  }

  // ════════════════════════════════════════════════════════════════
  //  ARRANQUE
  // ════════════════════════════════════════════════════════════════

  async _startAsHost () {
    // Config inválida: requireVerify sin vault dejaría la sala sin poder sentar a
    // nadie. Degradar conscientemente en vez de morir en silencio.
    if (this.config.requireVerify && !this.identity) {
      console.warn('[lobby] requireVerify pedido pero no hay identidad: se desactiva la verificación')
      this.config = { ...this.config, requireVerify: false }
    }
    this.roomId = this.transport.token
    this._acceptedRoomIds = new Set([this.transport.token])
    this.hostPubkey = this.myPubkey
    this._public.roomId = this.roomId
    this._public.hostPubkey = this.hostPubkey
    // El host es un miembro más (puede sentarse o ser espectador).
    this._members.set(this.transport.token, { pubkey: this.myPubkey, name: this.myName, verified: true, lastSeen: clock.now() })
    this._wire()
    // Anunciarse: canal de descubrimiento + canal de presencia de la sala.
    try { await this.transport.publish(discoveryChannel(this.gameId), { roomName: this.name, gameType: this.gameId }) } catch (_) {}
    try { await this.transport.publish(roomChannel(this.gameId, this.roomId)) } catch (_) {}
    this._startHeartbeat()
    this._afterStateChange()
    return this
  }

  // Re-publica la sala periódicamente: las entradas de canal del proxy expiran
  // (~20 min), así que sin esto una sala desaparecería del descubrimiento en
  // partidas largas. Reemplaza el _republish casero que hacían los bots.
  _startHeartbeat () {
    if (this._heartbeat) clearInterval(this._heartbeat)
    this._heartbeat = setInterval(() => {
      this.transport.publish(discoveryChannel(this.gameId), { roomName: this.name, gameType: this.gameId }).catch(() => {})
      this.transport.publish(roomChannel(this.gameId, this.roomId)).catch(() => {})
    }, 10 * 60 * 1000)
    if (this._heartbeat.unref) this._heartbeat.unref()
  }

  async _joinAsGuest () {
    this._public.roomId = this.roomId
    this._wire()
    try { await this.transport.publish(roomChannel(this.gameId, this.roomId)) } catch (_) {}
    this._sendHelloWithRetry()
    return this
  }

  _wire () {
    const off1 = this.transport.subscribe(this.gameId, (from, env, meta) => {
      if (this.role === 'host') {
        // INFO_REQUEST es de descubrimiento (pre-join); el resto debe traer un
        // roomId aceptado (el actual o el viejo durante la ventana de re-clave).
        if (env.k !== K.INFO_REQUEST && !this._acceptedRoomIds.has(env.r)) return
        this._onHostMessage(from, env, meta)
      } else {
        // HOST_REKEY puede venir del token nuevo del host; se valida por pubkey.
        if (env.k !== K.HOST_REKEY && env.r !== this.roomId) return
        this._onGuestMessage(from, env, meta)
      }
    })
    // rc se recalcula dinámicamente: this.roomId puede cambiar si el host reconecta.
    const off2 = this.transport.on('peer_disconnected', (token, channel) => {
      if (channel && channel !== roomChannel(this.gameId, this.roomId)) return
      this._onPeerGone(token)
    })
    const off3 = this.transport.on('channel_left', (channel, token) => {
      if (channel === roomChannel(this.gameId, this.roomId)) this._onPeerGone(token)
    })
    const off4 = this.transport.on('reconnect', () => this._onReconnect())
    this._unsub.push(off1, off2, off3, off4)
  }

  // ════════════════════════════════════════════════════════════════
  //  API PÚBLICA (host y guest)
  // ════════════════════════════════════════════════════════════════

  /** Tomar un asiento libre (si se omite, el primero disponible). */
  takeSeat (seatId) {
    if (this.isHost) {
      const id = seatId || this._firstOpenSeat()
      if (!id) return false
      if (this._occupySeat(id, this.transport.token, this.myPubkey, this.myName)) this._afterSeatChange()
      return true
    }
    this._sendHost(K.SEAT_TAKE, { seat: seatId || null })
    return true
  }

  /** Dejar el asiento (paso a espectador). */
  leaveSeat () {
    if (this.isHost) { if (this._vacateByToken(this.transport.token, { voluntary: true })) this._afterSeatChange() }
    else this._sendHost(K.SEAT_LEAVE, {})
  }

  /** Marcar/desmarcar "listo". */
  setReady (ready = true) {
    if (this.isHost) { if (this._setReady(this.transport.token, !!ready)) this._afterSeatChange() }
    else this._sendHost(K.READY, { ready: !!ready })
  }

  /** Volverse espectador explícitamente. */
  spectate () { this.leaveSeat() }

  /** Enviar una acción de juego al motor autoritativo. */
  action (action) {
    if (this.isHost) this._applyAction(this.transport.token, action)
    else this._sendHost(K.ACTION, { action })
  }

  /** Mensaje de chat (difundido por el host a toda la sala). */
  chat (text) {
    if (this.isHost) this._broadcastEvent('chat', { from: this.myPubkey, name: this.myName, text: String(text || '').slice(0, 500), ts: clock.now() })
    else this._sendHost(K.CHAT, { text })
  }

  /** Relay opaco (juegos sin motor que sincronizan su propio estado). */
  send (data) {
    if (this.isHost) this._broadcastEvent('message', { from: this.myPubkey, data })
    else this._sendHost(K.RELAY, { data })
  }

  /** Host-only: arrancar manualmente (start:'manual') o reiniciar. */
  start () {
    if (!this.isHost) return false
    this._startGame()
    return true
  }

  /**
   * Calificar a un co-jugador: lo agrega a contactos del vault y atesta en el
   * registro, adjuntando el recibo de partida co-firmado si existe (→ txBound).
   */
  ratePlayer (pubkey, valueOrIndicators, opts = {}) {
    const receipt = this._receipts.get(pubkey)
    const token = this._tokenByPubkey(pubkey)
    return repRatePlayer(this.identity, this.reputation, pubkey, valueOrIndicators, {
      ...opts, receipt: receipt && receipt.sigB ? receipt : opts.receipt, token
    })
  }

  /** Recibo co-firmado entre yo y `pubkey` (o null si no se completó). */
  matchReceipt (pubkey) {
    const r = this._receipts.get(pubkey)
    return r && r.sigA && r.sigB ? r : null
  }

  /** Salir de la sala y liberar recursos. */
  async leave () {
    for (const off of this._unsub) { try { off() } catch (_) {} }
    this._unsub = []
    for (const t of this._graceTimers.values()) clearTimeout(t)
    this._graceTimers.clear()
    if (this._joinTimer) clearTimeout(this._joinTimer)
    if (this._rekeyTimer) clearTimeout(this._rekeyTimer)
    if (this._hostLostTimer) clearTimeout(this._hostLostTimer)
    if (this._heartbeat) clearInterval(this._heartbeat)
    if (this.isHost) {
      this._broadcastEvent('closed', { reason: 'host-left' })
      try { await this.transport.unpublish(discoveryChannel(this.gameId)) } catch (_) {}
    }
    try { await this.transport.unpublish(roomChannel(this.gameId, this.roomId)) } catch (_) {}
    this.emit('left')
    this.removeAllListeners()
  }

  // ════════════════════════════════════════════════════════════════
  //  HOST: manejo de mensajes de guests
  // ════════════════════════════════════════════════════════════════

  _onHostMessage (from, env) {
    const d = env.d || {}
    switch (env.k) {
      case K.HELLO: this._hostHello(from, d); break
      case K.REQUEST_STATE: this._sendStateTo(from); break
      case K.INFO_REQUEST: this._sendInfoTo(from); break
      case K.VERIFY_RESP: this._hostVerifyResp(from, d); break
      case K.SEAT_TAKE: this._hostSeatTake(from, d); break
      case K.SEAT_LEAVE: if (this._vacateByToken(from, { voluntary: true })) this._afterSeatChange(); break
      case K.READY: if (this._setReady(from, !!d.ready)) this._afterSeatChange(); break
      case K.SPECTATE: if (this._vacateByToken(from, { voluntary: true })) this._afterSeatChange(); break
      case K.ACTION: this._applyAction(from, d.action); break
      case K.CHAT: { const m = this._members.get(from); this._broadcastEvent('chat', { from: m && m.pubkey, name: m && m.name, text: String(d.text || '').slice(0, 500), ts: clock.now() }); break }
      case K.RELAY: { const m = this._members.get(from); this._broadcastEvent('message', { from: m && m.pubkey, data: d.data }); break }
      case K.RECEIPT_SIGN: this._hostReceiptSign(from, d); break
      case K.RESULT_SIGN: this._hostResultSign(from, d); break
      case K.PING: this._touch(from); this._sendTo(from, K.PONG, { ts: d.ts }); break
      default: break
    }
  }

  _hostSeatTake (from, d) {
    const m = this._members.get(from)
    if (!m) return
    // Si todavía no se verificó, encolar la intención y aplicarla tras verificar
    // (evita la carrera HELLO→SEAT_TAKE en quickMatch/auto-seat).
    if (this.config.requireVerify && !m.verified) { m.pendingSeat = d.seat || true; return }
    const id = d.seat || this._firstOpenSeat()
    if (this._occupySeat(id, from, m.pubkey, m.name)) this._afterSeatChange()
  }

  _hostHello (from, d) {
    const claimedPubkey = d.pubkey || null
    const name = (d.name && String(d.name).slice(0, 40)) || null
    // Mutar en sitio para preservar campos en vuelo (verified, nonce, pendingSeat)
    // ante reintentos de HELLO.
    const m = this._members.get(from) || { verified: !this.config.requireVerify }
    m.pubkey = claimedPubkey
    if (name) m.name = name
    m.lastSeen = clock.now()
    this._members.set(from, m)
    // Verificación de identidad antes de admitir/sentar (anti-impersonación).
    if (this.config.requireVerify && this.identity && claimedPubkey) {
      this._sendVerifyChallenge(from)
    } else {
      this._admit(from)
    }
    // Siempre mandamos el estado actual para que el guest pinte el lobby.
    this._sendStateTo(from)
  }

  async _sendVerifyChallenge (from) {
    try {
      const { nonce } = await this.identity.makeChallenge()
      const m = this._members.get(from); if (m) m.nonce = nonce
      this._sendTo(from, K.VERIFY_CHALLENGE, { nonce })
    } catch (_) {
      // No admitir sin verificar cuando la política lo exige: expulsar para que
      // el guest pueda reintentar un HELLO fresco.
      this._sendTo(from, K.KICKED, { reason: 'verify-unavailable' })
      this._members.delete(from)
    }
  }

  async _hostVerifyResp (from, d) {
    if (!this.identity) return
    try {
      const res = await this.identity.verifyResponse(d)
      if (!res || !res.ok) { this._sendTo(from, K.KICKED, { reason: 'verify-failed' }); this._members.delete(from); return }
      const m = this._members.get(from) || {}
      m.verified = true
      m.pubkey = res.publickey
      this._members.set(from, m)
      await this._admit(from)
    } catch (_) {}
  }

  async _admit (from) {
    const m = this._members.get(from)
    if (!m) return
    // Gate de reputación (host-side): rechazar desconocidos / baja reputación.
    if (this._gate && m.pubkey) {
      const verdict = await this._gate(m.pubkey)
      if (!verdict.ok) { this._sendTo(from, K.KICKED, { reason: verdict.reason || 'reputation' }); this._members.delete(from); return }
    }
    // Reclamo de asiento por pubkey (reconexión dentro del grace period).
    const reclaimed = this._reclaimSeat(from, m.pubkey)
    if (!reclaimed) this._ensureSpectator(from)
    // Intención de asiento encolada antes de verificar (auto-seat / quickMatch).
    if (!reclaimed && m.pendingSeat) {
      const sid = m.pendingSeat === true ? this._firstOpenSeat() : m.pendingSeat
      m.pendingSeat = null
      if (sid) this._occupySeat(sid, from, m.pubkey, m.name)
    }
    this._afterSeatChange()
  }

  _hostReceiptSign (from, d) {
    const rec = this._pendingReceiptSig.get(d.receiptId)
    if (!rec || from !== rec.token) return // sólo el destinatario del recibo puede co-firmarlo
    const full = { a: rec.a, b: rec.b, ts: rec.ts, sigA: rec.sigA, sigB: d.sig }
    this._receipts.set(rec.peerPubkey, full)
    this._pendingReceiptSig.delete(d.receiptId)
    this.emit('receipt', { pubkey: rec.peerPubkey, receipt: full })
  }

  // ── Mutadores de asientos (host) ───────────────────────────────

  _initSeats () {
    for (const id of this.config.seats.ids) {
      this._seats[id] = { id, pubkey: null, token: null, name: null, ready: false, status: SEAT.OPEN, disconnectAt: null }
    }
  }

  _firstOpenSeat () {
    for (const id of this.config.seats.ids) if (this._seats[id].status === SEAT.OPEN) return id
    return null
  }

  _seatIdByToken (token) {
    for (const id of this.config.seats.ids) if (this._seats[id].token === token) return id
    return null
  }

  _tokenByPubkey (pubkey) {
    for (const [t, m] of this._members) if (m.pubkey && m.pubkey === pubkey) return t
    return null
  }

  _memberOk (from) {
    const m = this._members.get(from)
    if (!m) return false
    if (this.config.requireVerify && !m.verified) return false
    return true
  }

  _occupySeat (seatId, token, pubkey, name) {
    if (!seatId || !this._seats[seatId]) return false
    const seat = this._seats[seatId]
    if (seat.status === SEAT.OCCUPIED && seat.token !== token) return false // sólo asientos libres
    const prev = this._seatIdByToken(token)
    if (prev && prev !== seatId) this._clearSeat(prev) // movida de asiento
    this._ensureMember(token, pubkey, name)
    seat.token = token; seat.pubkey = pubkey || seat.pubkey; seat.name = name || seat.name || 'Jugador'
    seat.status = SEAT.OCCUPIED; seat.ready = false; seat.disconnectAt = null
    this._clearGrace(seatId)
    return true
  }

  _setReady (token, ready) {
    const id = this._seatIdByToken(token)
    if (!id) return false
    this._seats[id].ready = ready
    return true
  }

  _vacateByToken (token, { voluntary } = {}) {
    const id = this._seatIdByToken(token)
    if (!id) return false
    this._clearSeat(id)
    this._ensureSpectator(token)
    if (voluntary) this._applyVacancyPolicy(id, token) // excluir al que se va del fill
    return true
  }

  _clearSeat (id) {
    const s = this._seats[id]
    s.token = null; s.pubkey = null; s.name = null; s.ready = false; s.status = SEAT.OPEN; s.disconnectAt = null
    this._clearGrace(id)
  }

  _reclaimSeat (token, pubkey) {
    if (!pubkey) return false
    for (const id of this.config.seats.ids) {
      const s = this._seats[id]
      if (s.status === SEAT.DISCONNECTED && s.pubkey === pubkey) {
        s.token = token; s.status = SEAT.OCCUPIED; s.disconnectAt = null
        this._clearGrace(id)
        if (this._status === STATUS.PAUSED && !this._hasDisconnectedSeat()) this._status = STATUS.PLAYING
        this.emit('event', { event: 'reconnected', data: { seat: id, pubkey } })
        return true
      }
    }
    return false
  }

  _ensureMember (token, pubkey, name) {
    const m = this._members.get(token) || { verified: !this.config.requireVerify }
    if (pubkey) m.pubkey = pubkey
    if (name) m.name = name
    m.lastSeen = clock.now()
    this._members.set(token, m)
  }

  _ensureSpectator (token) {
    if (!this.config.allowSpectators) return
    if (this._seatIdByToken(token)) return
    this._ensureMember(token)
  }

  _touch (from) { const m = this._members.get(from); if (m) m.lastSeen = clock.now() }

  // ── Política de asiento vacante / desconexión ──────────────────

  _applyVacancyPolicy (seatId, excludeToken = null) {
    const policy = this.config.onSeatVacated
    if (this._status !== STATUS.PLAYING && this._status !== STATUS.PAUSED) return
    if (policy === 'forfeit') {
      this._endGame({ winner: this._otherSeatsWinner(seatId), reason: 'forfeit' })
    } else if (policy === 'fill') {
      if (!this._fillFromSpectators(seatId, excludeToken) && this._occupiedCount() < this.config.seats.min) this._status = STATUS.PAUSED
    } else { // 'pause'
      if (this._occupiedCount() < this.config.seats.min) this._status = STATUS.PAUSED
    }
  }

  _onPeerGone (token) {
    if (this.role === 'guest') {
      if (token === this._hostToken) this._onHostLost()
      return
    }
    const id = this._seatIdByToken(token)
    this._members.delete(token)
    if (id) {
      const policy = this.config.onSeatVacated
      if (policy === 'forfeit' && (this._status === STATUS.PLAYING || this._status === STATUS.PAUSED)) {
        this._endGame({ winner: this._otherSeatsWinner(id), reason: 'forfeit' })
        return
      }
      const s = this._seats[id]
      s.status = SEAT.DISCONNECTED; s.token = null; s.disconnectAt = clock.now()
      if (this._status === STATUS.PLAYING && policy !== 'fill' && this._occupiedCount() < this.config.seats.min) this._status = STATUS.PAUSED
      if (policy === 'fill') this._fillFromSpectators(id) // el miembro caído ya fue borrado de _members
      if (this._seats[id].status === SEAT.DISCONNECTED) this._startGrace(id) // no arrancar grace si ya se rellenó
    }
    this._afterStateChange()
  }

  _startGrace (seatId) {
    this._clearGrace(seatId)
    const ms = this.config.disconnectGraceMs
    const at = this._seats[seatId].disconnectAt
    const t = setTimeout(() => {
      const s = this._seats[seatId]
      if (s.status === SEAT.DISCONNECTED && s.disconnectAt === at) {
        this._clearSeat(seatId)
        this.emit('event', { event: 'seat-expired', data: { seat: seatId } })
        this._afterStateChange()
      }
    }, ms)
    if (t.unref) t.unref()
    this._graceTimers.set(seatId, t)
  }

  _clearGrace (seatId) {
    const t = this._graceTimers.get(seatId)
    if (t) { clearTimeout(t); this._graceTimers.delete(seatId) }
  }

  _fillFromSpectators (seatId, excludeToken = null) {
    for (const [token, m] of this._members) {
      if (token === excludeToken) continue // no re-sentar al que se acaba de ir
      if (this._seatIdByToken(token)) continue
      if (token === this.transport.token) continue
      if (this.config.requireVerify && !m.verified) continue
      if (this._occupySeat(seatId, token, m.pubkey, m.name)) return true
    }
    return false
  }

  // ── Inicio / fin de partida ────────────────────────────────────

  _checkAutoStart () {
    if (this._status === STATUS.PAUSED) {
      if (this._occupiedCount() >= this.config.seats.min && !this._hasDisconnectedSeat()) this._status = STATUS.PLAYING
      return
    }
    if (this._status !== STATUS.WAITING) return
    const mode = this.config.start
    if (mode === 'manual') return
    const occupied = this._occupiedCount()
    if (occupied < this.config.seats.min) return
    if (mode === 'ready' && !this._allOccupiedReady()) return
    this._startGame()
  }

  _startGame () {
    this._status = STATUS.PLAYING
    this._result = null
    if (this.engine) this.engine.start(this.config.seed)
    this._afterStateChange()
    this._broadcastEvent('started', { ts: clock.now() })
  }

  _endGame (result) {
    this._status = STATUS.ENDED
    this._result = result || { winner: null, reason: 'ended' }
    this._afterStateChange()
    this._broadcastEvent('ended', this._result)
    this.emit('ended', this._result)
    this._offerReceipts()
    this._offerResults()
  }

  _applyAction (token, action) {
    if (this._status !== STATUS.PLAYING) { this._sendTo(token, K.EVENT, { event: 'rejected', data: { reason: 'not-playing' } }); return }
    const seat = this._seatIdByToken(token)
    if (!seat) { this._sendTo(token, K.EVENT, { event: 'rejected', data: { reason: 'not-seated' } }); return }
    if (!this.engine) { this._broadcastEvent('action', { seat, action }); return } // relay autoritativo
    try {
      this.engine.apply(seat, action, this._seatsSnapshot())
    } catch (e) {
      this._sendTo(token, K.EVENT, { event: 'rejected', data: { reason: (e && e.message) || 'invalid' } })
      return
    }
    const over = this.engine.checkOver()
    if (over) { this._endGame(over); return }
    this._afterStateChange()
  }

  // ── Recibos co-firmados (host inicia con cada co-jugador) ───────

  async _offerReceipts () {
    if (!this.identity || !this.myPubkey) return
    const ids = this.config.seats.ids
    for (let i = 0; i < ids.length; i++) {
      const s = this._seats[ids[i]]
      if (!s.pubkey || samePubkey(s.pubkey, this.myPubkey) || !s.token) continue
      try {
        const a = this.myPubkey, b = s.pubkey
        const ts = clock.now() + i // ts distinto por par → receiptId no adivinable entre peers
        const sigA = await signReceiptHalf(this.identity, a, b, ts)
        const receiptId = `${ts}:${ids[i]}`
        this._pendingReceiptSig.set(receiptId, { a, b, ts, sigA, peerPubkey: b, token: s.token })
        this._sendTo(s.token, K.RECEIPT_OFFER, { receiptId, receipt: { a, b, ts, sigA } })
      } catch (_) {}
    }
  }

  // ── Evento de indicador derivado co-firmado (p.ej. ELO): el host ofrece el
  //    resultado (outcome) a co-firmar con cada co-jugador ──
  async _offerResults () {
    if (!this.identity || !this.myPubkey) return
    const indicator = this.config.resultIndicator || 'elo'
    const scope = this.config.resultScope || this.gameId
    const winnerSeat = this._result && this._result.winner // id de asiento ganador o null
    const winnerPub = winnerSeat ? (this._seats[winnerSeat] && this._seats[winnerSeat].pubkey) : null
    const ids = this.config.seats.ids
    for (let i = 0; i < ids.length; i++) {
      const s = this._seats[ids[i]]
      if (!s.pubkey || samePubkey(s.pubkey, this.myPubkey) || !s.token) continue
      try {
        const a = this.myPubkey, b = s.pubkey
        const outcome = winnerPub ? (samePubkey(winnerPub, a) ? 'a' : (samePubkey(winnerPub, b) ? 'b' : 'draw')) : 'draw'
        const ts = clock.now() + i
        const data = eventPayload(indicator, scope, a, b, outcome, ts)
        const sigA = await signEventHalf(this.identity, indicator, scope, a, b, outcome, ts)
        const resultId = `res:${ts}:${ids[i]}`
        this._pendingResults.set(resultId, { data, sigA, token: s.token })
        this._sendTo(s.token, K.RESULT_OFFER, { resultId, data, sigA })
      } catch (_) {}
    }
  }

  _hostResultSign (from, d) {
    const rec = this._pendingResults.get(d.resultId)
    if (!rec || from !== rec.token) return // sólo el destinatario co-firma su resultado
    this._pendingResults.delete(d.resultId)
    const coSigned = { data: rec.data, sigA: rec.sigA, sigB: d.sig }
    this.emit('result', { indicator: rec.data.indicator, scope: rec.data.scope, a: rec.data.a, b: rec.data.b, outcome: rec.data.outcome, coSigned })
  }

  // Ganador relativo (a/b/draw) según lo que YO vi (anti-trampa del guest).
  _relativeWinner (a, b, result) {
    const seat = result && result.winner
    const pub = seat ? (this._public.seats && this._public.seats[seat] && this._public.seats[seat].pubkey) : null
    if (!pub) return 'draw'
    if (samePubkey(pub, a)) return 'a'
    if (samePubkey(pub, b)) return 'b'
    return 'draw'
  }

  async _guestResultOffer (d) {
    if (!this.identity || !this.myPubkey || !d.data) return
    const { indicator, scope, a, b, outcome, ts } = d.data
    if (!samePubkey(a, this.myPubkey) && !samePubkey(b, this.myPubkey)) return
    const other = samePubkey(a, this.myPubkey) ? b : a
    if (!samePubkey(other, this._public.hostPubkey)) return
    // Anti-trampa: sólo co-firmo si el resultado del offer coincide con el que YO vi.
    if (this._relativeWinner(a, b, this._public.result) !== outcome) return
    try {
      const sigB = await signEventHalf(this.identity, indicator, scope, a, b, outcome, ts)
      this._sendHost(K.RESULT_SIGN, { resultId: d.resultId, sig: sigB })
      this.emit('result', { indicator, scope, a, b, outcome, coSigned: { data: d.data, sigA: d.sigA, sigB } })
    } catch (_) {}
  }

  // ════════════════════════════════════════════════════════════════
  //  GUEST: manejo de mensajes del host
  // ════════════════════════════════════════════════════════════════

  _onGuestMessage (from, env) {
    const d = env.d || {}
    if (env.k === K.HOST_REKEY) { this._guestRekey(from, d); return } // viene del token nuevo
    if (from !== this._hostToken) return // sólo confiamos en el host
    switch (env.k) {
      case K.STATE: this._guestState(d, env.s); break
      case K.EVENT: this._guestEvent(d); break
      case K.VERIFY_CHALLENGE: this._guestVerify(d); break
      case K.RECEIPT_OFFER: this._guestReceiptOffer(d); break
      case K.RESULT_OFFER: this._guestResultOffer(d); break
      case K.KICKED: this.emit('kicked', { reason: d.reason }); break
      case K.PONG: break
      default: break
    }
  }

  _guestState (data, seq) {
    if (typeof seq === 'number') {
      if (seq <= this._lastSeq) return // estado viejo / fuera de orden
      this._lastSeq = seq
    }
    this._clearHostLost() // recibimos estado: el host está vivo
    if (this._joinTimer) { clearTimeout(this._joinTimer); this._joinTimer = null }
    this._public = { ...data, version: typeof seq === 'number' ? seq : (this._public.version || 0) }
    this.emit('update', this._public)
    this.emit('state', this._public.game)
  }

  _guestEvent (d) {
    const ev = d.event
    this.emit('event', d)
    if (ev === 'chat') this.emit('chat', d.data)
    else if (ev === 'message') this.emit('message', d.data)
    else if (ev === 'action') this.emit('action', d.data)
    else if (ev === 'ended') { this._public = { ...this._public, status: STATUS.ENDED, result: d.data }; this.emit('ended', d.data) }
    else if (ev === 'closed') this.emit('closed', d.data)
    else if (ev === 'rejected') this.emit('rejected', d.data)
    else if (ev === 'started') this.emit('started', d.data)
    else if (ev === 'reconnected' || ev === 'seat-expired') { /* el STATE que sigue refleja el cambio */ }
  }

  async _guestVerify (d) {
    if (!this.identity || !d.nonce) return
    try {
      const resp = await this.identity.signChallenge(d.nonce)
      this._sendHost(K.VERIFY_RESP, resp)
    } catch (_) {}
  }

  async _guestReceiptOffer (d) {
    if (!this.identity || !this.myPubkey || !d.receipt) return
    const { a, b, ts } = d.receipt
    // Debo ser uno de los extremos del par...
    if (!samePubkey(a, this.myPubkey) && !samePubkey(b, this.myPubkey)) return
    const peer = samePubkey(a, this.myPubkey) ? b : a
    // ...y la contraparte tiene que ser el host real (pubkey conocido por el STATE).
    if (!samePubkey(peer, this._public.hostPubkey)) return
    try {
      const sigB = await signReceiptHalf(this.identity, a, b, ts)
      const full = { a, b, ts, sigA: d.receipt.sigA, sigB }
      this._receipts.set(peer, full)
      this._sendHost(K.RECEIPT_SIGN, { receiptId: d.receiptId, sig: sigB })
      this.emit('receipt', { pubkey: peer, receipt: full })
    } catch (_) {}
  }

  _onHostLost () {
    // No declarar la sala muerta de inmediato: el host puede estar reconectando
    // (cambia de token y avisa por HOST_REKEY). Esperamos un grace; si vuelve,
    // _guestRekey/_guestState cancelan el timer.
    if (this._hostLostTimer) return
    const ms = this.config.disconnectGraceMs || 45000
    this.emit('event', { event: 'host-disconnected', data: {} })
    this._hostLostTimer = setTimeout(() => {
      this._hostLostTimer = null
      const policy = this.config.onHostLost || 'end'
      if (policy === 'end') {
        this._public = { ...this._public, status: STATUS.ENDED }
        this.emit('closed', { reason: 'host-lost' })
      }
      // 'migrate' (elección determinista de nuevo host) queda como extensión futura.
    }, ms)
    if (this._hostLostTimer.unref) this._hostLostTimer.unref()
  }

  _clearHostLost () { if (this._hostLostTimer) { clearTimeout(this._hostLostTimer); this._hostLostTimer = null } }

  _sendHelloWithRetry () {
    const send = () => {
      this._sendHost(K.HELLO, { pubkey: this.myPubkey, name: this.myName })
      this._joinAttempts++
      if (this._lastSeq < 0 && this._joinAttempts < 5) {
        this._joinTimer = setTimeout(send, 1200)
        if (this._joinTimer.unref) this._joinTimer.unref()
      }
    }
    send()
  }

  _onReconnect () {
    if (this.role === 'host') {
      const oldRoomId = this.roomId
      const newToken = this.transport.token
      if (newToken && newToken !== oldRoomId) {
        this._acceptedRoomIds.add(newToken)
        this.roomId = newToken
        this._public.roomId = newToken
        // Re-clave del self-member y del asiento propio (estaban con el token viejo).
        const self = this._members.get(oldRoomId)
        if (self) { this._members.delete(oldRoomId); this._members.set(newToken, self) }
        for (const id of this.config.seats.ids) {
          const s = this._seats[id]
          if (s.pubkey && samePubkey(s.pubkey, this.myPubkey)) { s.token = newToken; break }
        }
        // Avisar a los miembros por pubkey (sobrevive al cambio de token; cola offline).
        for (const m of this._members.values()) {
          if (m.pubkey && !samePubkey(m.pubkey, this.myPubkey)) {
            try { this.transport.sendByPubkey(m.pubkey, this._env(K.HOST_REKEY, { oldRoomId, newRoomId: newToken, hostPubkey: this.myPubkey })) } catch (_) {}
          }
        }
        // Dejar de aceptar el roomId viejo tras una ventana de transición.
        if (this._rekeyTimer) clearTimeout(this._rekeyTimer)
        this._rekeyTimer = setTimeout(() => {
          this._acceptedRoomIds.delete(oldRoomId)
          this.transport.unpublish(roomChannel(this.gameId, oldRoomId)).catch(() => {})
        }, 20000)
        if (this._rekeyTimer.unref) this._rekeyTimer.unref()
      }
      this.transport.publish(discoveryChannel(this.gameId), { roomName: this.name, gameType: this.gameId }).catch(() => {})
      this.transport.publish(roomChannel(this.gameId, this.roomId)).catch(() => {})
      this._afterStateChange() // re-difundir estado a los miembros vivos
    } else {
      if (this._joinTimer) { clearTimeout(this._joinTimer); this._joinTimer = null }
      this.transport.publish(roomChannel(this.gameId, this.roomId)).catch(() => {})
      this._lastSeq = -1; this._joinAttempts = 0
      this._sendHelloWithRetry()
    }
  }

  _guestRekey (from, d) {
    if (!d || !d.newRoomId) return
    // Validar que el aviso viene del host real (por pubkey conocido del STATE).
    if (this._public.hostPubkey && d.hostPubkey && !samePubkey(d.hostPubkey, this._public.hostPubkey)) return
    this._clearHostLost() // el host volvió
    if (this.roomId === d.newRoomId) return
    this.roomId = d.newRoomId
    this._hostToken = d.newRoomId
    this._public.roomId = d.newRoomId
    this.transport.publish(roomChannel(this.gameId, this.roomId)).catch(() => {})
    this._lastSeq = -1; this._joinAttempts = 0
    this._sendHelloWithRetry()
  }

  // ════════════════════════════════════════════════════════════════
  //  DIFUSIÓN / SNAPSHOTS (host)
  // ════════════════════════════════════════════════════════════════

  _afterSeatChange () { this._checkAutoStart(); this._afterStateChange() }

  _afterStateChange () {
    this._seq++
    for (const token of this._recipients()) {
      try { this._sendStateTo(token) } catch (e) { console.warn('[lobby] STATE falló para', token, e) }
    }
    try { this._refreshLocal() } catch (e) { console.warn('[lobby] refresh local falló', e) }
  }

  _refreshLocal () {
    const seat = this._seatIdByToken(this.transport.token)
    this._public = { ...this._snapshot(seat), version: this._seq }
    this.emit('update', this._public)
    this.emit('state', this._public.game)
  }

  _recipients () {
    const set = new Set()
    for (const token of this._members.keys()) if (token && token !== this.transport.token) set.add(token)
    return [...set]
  }

  _sendStateTo (token) {
    const seat = this._seatIdByToken(token)
    this._sendTo(token, K.STATE, this._snapshot(seat), this._seq)
  }

  _sendInfoTo (token) { this._sendTo(token, K.INFO, { summary: this._summary() }) }

  _summary () {
    const seatsArr = this.config.seats.ids.map(id => ({ id, status: this._seats[id].status, name: this._seats[id].name }))
    const open = seatsArr.filter(s => s.status === SEAT.OPEN).length
    return {
      roomId: this.roomId, gameId: this.gameId, name: this.name, hostPubkey: this.hostPubkey,
      hostName: this.myName, status: this._status, players: this._occupiedCount(),
      seats: seatsArr, openSeats: open, max: this.config.seats.max, spectators: this._spectatorCount()
    }
  }

  _snapshot (seat) {
    return {
      roomId: this.roomId, gameId: this.gameId, name: this.name, hostPubkey: this.hostPubkey,
      status: this._status, seats: this._publicSeats(), spectators: this._publicSpectators(),
      result: this._result, game: this.engine ? this.engine.viewFor(seat) : null,
      mySeatId: seat || null // personalizado por destinatario: permite mySeat sin pubkey
    }
  }

  _publicSeats () {
    const out = {}
    for (const id of this.config.seats.ids) {
      const s = this._seats[id]
      out[id] = { id, pubkey: s.pubkey, name: s.name, ready: s.ready, status: s.status, occupied: s.status === SEAT.OCCUPIED }
    }
    return out
  }

  _publicSpectators () {
    const out = []
    for (const [token, m] of this._members) {
      if (this._seatIdByToken(token)) continue
      out.push({ pubkey: m.pubkey, name: m.name })
    }
    return out
  }

  _seatsSnapshot () {
    const out = {}
    for (const id of this.config.seats.ids) {
      const s = this._seats[id]
      out[id] = { pubkey: s.pubkey, name: s.name, status: s.status, occupied: s.status === SEAT.OCCUPIED }
    }
    return out
  }

  _broadcastEvent (event, data) {
    if (this.role !== 'host') return
    for (const token of this._recipients()) this._sendTo(token, K.EVENT, { event, data })
    this.emit('event', { event, data })
    if (event === 'chat') this.emit('chat', data)
    else if (event === 'message') this.emit('message', data)
    else if (event === 'action') this.emit('action', data)
    else if (event === 'started') this.emit('started', data)
    else if (event === 'closed') this.emit('closed', data)
  }

  // ── Cuentas auxiliares ─────────────────────────────────────────
  _occupiedCount () { let n = 0; for (const id of this.config.seats.ids) if (this._seats[id].status === SEAT.OCCUPIED) n++; return n }
  _allOccupiedReady () { for (const id of this.config.seats.ids) { const s = this._seats[id]; if (s.status === SEAT.OCCUPIED && !s.ready) return false } return true }
  _hasDisconnectedSeat () { for (const id of this.config.seats.ids) if (this._seats[id].status === SEAT.DISCONNECTED) return true; return false }
  _spectatorCount () { let n = 0; for (const token of this._members.keys()) if (!this._seatIdByToken(token)) n++; return n }
  _otherSeatsWinner (excludeId) {
    const others = this.config.seats.ids.filter(id => id !== excludeId && this._seats[id].status === SEAT.OCCUPIED)
    return others.length === 1 ? others[0] : null
  }

  // ── Envío ──────────────────────────────────────────────────────
  get _gate () { return this.config.gate || null }
  _env (kind, data, seq) { return envelope(this.gameId, this.roomId, kind, data, seq) }
  _sendTo (token, kind, data, seq) { try { this.transport.send(token, this._env(kind, data, seq)) } catch (e) { console.warn('[lobby] send failed:', e) } }
  _sendHost (kind, data) { this._sendTo(this._hostToken || this.roomId, kind, data) }
}
