// Protocolo de mensajes de lobby/room sobre el transporte Dotrino.
//
// Una sola conexión al proxy puede ser compartida por varias apps del
// ecosistema (messenger, varios juegos a la vez). Por eso TODO mensaje de esta
// librería viaja en un sobre namespaced que se puede demultiplexar por
// (gameId, roomId) y descartar lo ajeno sin ambigüedad.
//
// El proxy auto-parsea los strings JSON: send(obj) llega al receptor como
// objeto ya parseado en el callback 'message'. Aprovechamos eso enviando el
// sobre como objeto plano. Evitamos el campo `t` a nivel raíz porque el
// cliente lo reserva para señalización WebRTC (parsed.t === '__cc_rtc__').

/** Marca de versión del sobre. */
export const ENVELOPE_TAG = 1

/** Tipos de mensaje (campo `k` = kind). */
export const K = {
  // ── guest → host ─────────────────────────────────────────────
  HELLO: 'hello',           // { pubkey?, name? }  entrar + pedir estado
  REQUEST_STATE: 'reqstate', // {}  resync explícito
  SEAT_TAKE: 'seat.take',   // { seat }
  SEAT_LEAVE: 'seat.leave', // {}
  READY: 'ready',           // { ready:boolean }
  SPECTATE: 'spectate',     // {}
  ACTION: 'action',         // { action }  jugada de juego (al motor)
  CHAT: 'chat',             // { text }
  RELAY: 'relay',           // { data }  mensaje opaco (room.send sin motor)
  VERIFY_RESP: 'verify.resp', // { nonce, publickey, signature, encryptionPubkey? }
  RECEIPT_SIGN: 'receipt.sign', // { receiptId, sig }  segunda firma del recibo
  RATING_QUERY: 'rep.query', // { queryId, subject }
  RATING_REPLY: 'rep.reply', // { queryId, subject, mine, endorsements }
  INFO_REQUEST: 'info.req',  // {}  discovery: pedir resumen de la sala
  PING: 'ping',             // { ts }  heartbeat de presencia
  INVITE: 'invite',         // { roomId, name, from, fromName }  invitación (sendByPubkey)
  HOST_REKEY: 'host.rekey', // { oldRoomId, newRoomId, hostPubkey }  el host reconectó con token nuevo

  // ── host → guest(s) ──────────────────────────────────────────
  STATE: 'state',           // snapshot completo personalizado por asiento
  EVENT: 'event',           // { event, data }  eventos laterales (chat, started, ended, rejected)
  INFO: 'info',             // { summary }  respuesta de discovery
  VERIFY_CHALLENGE: 'verify.challenge', // { nonce }
  RECEIPT_OFFER: 'receipt.offer', // { receiptId, receipt }  mitad a co-firmar
  RESULT_OFFER: 'result.offer', // { resultId, data:{op:'result',gameId,a,b,winner,ts}, sigA }  resultado a co-firmar
  RESULT_SIGN: 'result.sign',   // { resultId, sig }  segunda firma del resultado (para ELO)
  KICKED: 'kicked',         // { reason }
  PONG: 'pong'              // { ts }
}

/** Canal de descubrimiento de salas de un juego (lista tokens de hosts). */
export const discoveryChannel = (gameId) => `cclobby/${gameId}`
/** Canal de presencia de una sala concreta (host + guests publican aquí). */
export const roomChannel = (gameId, roomId) => `ccroom/${gameId}/${roomId}`

/**
 * Construye un sobre.
 * @param {string} gameId
 * @param {string} roomId
 * @param {string} kind  uno de K
 * @param {any} data
 * @param {number} [seq]  número de secuencia autoritativo (host→guest)
 */
export function envelope (gameId, roomId, kind, data, seq) {
  const env = { __ccl: ENVELOPE_TAG, g: gameId, r: roomId, k: kind, d: data || {} }
  if (typeof seq === 'number') env.s = seq
  return env
}

/**
 * ¿Es un mensaje de esta librería? El callback 'message' del proxy entrega el
 * payload ya parseado cuando era JSON; aceptamos también un string JSON por las
 * dudas (otros transportes / WebRTC).
 * @returns {null | { g, r, k, d, s }}
 */
export function parseEnvelope (payload) {
  let obj = payload
  if (typeof payload === 'string') {
    try { obj = JSON.parse(payload) } catch (_) { return null }
  }
  if (!obj || typeof obj !== 'object' || obj.__ccl !== ENVELOPE_TAG) return null
  if (typeof obj.k !== 'string') return null
  return { g: obj.g, r: obj.r, k: obj.k, d: obj.d || {}, s: typeof obj.s === 'number' ? obj.s : null }
}
