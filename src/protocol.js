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

/**
 * NODO DUEÑO DE LOS CANALES.
 *
 * Un canal del proxio puede llevar delante el prefijo del nodo que lo hospeda
 * (`<id de 12>/loquesea`). Ese nodo guarda la membresía y los demás le pasan las
 * operaciones. Sin prefijo, cada proxio tiene su propia copia del canal — que es
 * lo que hacía que dos personas en proxios distintos NO se vieran en la misma
 * lista de salas, aunque los mensajes entre ellas sí cruzaran.
 *
 * El **canal de descubrimiento** es uno solo para todo el ecosistema, así que
 * tiene que vivir en un nodo fijo: si cada quien lo publicara en el suyo,
 * habría tantas listas de salas como proxios. Se fija con `setLobbyHomeNode()`
 * pasándole el id del proxio elegido (se lee de `client.node`). Mientras no se
 * fije, el descubrimiento es local a cada proxio.
 */
const NODE_ID_LEN = 12
// Comprueba la FORMA, no el alfabeto exacto, y es a propósito: el alfabeto lo
// decide el proxio (que excluye los caracteres confundibles) y esta librería no
// tiene por qué llevar una copia que se desincronice. Un id con un símbolo que
// el proxio no emite simplemente no va a coincidir con ningún nodo.
const isNodeId = (s) => new RegExp(`^[1-9A-Z]{${NODE_ID_LEN}}$`).test(String(s || ''))

// Sin valor por defecto: el id de un proxio se DERIVA de su llave, así que no
// hay ninguno que se pueda escribir aquí de antemano. Mientras no se fije, el
// canal de descubrimiento es local a cada proxio (comportamiento de siempre).
let LOBBY_HOME_NODE = null

/** Fija en qué proxio vive el canal de descubrimiento de salas. */
export function setLobbyHomeNode (nodeId) {
  LOBBY_HOME_NODE = isNodeId(nodeId) ? nodeId : null
}

const withNode = (prefix, name) => (prefix ? `${prefix}/${name}` : name)

/** Canal de descubrimiento de salas de un juego (lista instancias de hosts). */
export const discoveryChannel = (gameId) => withNode(LOBBY_HOME_NODE, `cclobby/${gameId}`)

/**
 * Canal de presencia de una sala concreta (host + guests publican aquí).
 *
 * Vive en el proxio DEL HOST, que se lee del propio `roomId`: el roomId es la
 * instancia del host y las instancias llevan delante el prefijo de su nodo. Así
 * la sala se hospeda donde está quien la abrió, sin que nadie tenga que
 * declararlo ni acordarlo.
 */
export const roomChannel = (gameId, roomId) => {
  const id = String(roomId || '').slice(0, NODE_ID_LEN)
  return withNode(isNodeId(id) ? id : null, `ccroom/${gameId}/${roomId}`)
}

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
