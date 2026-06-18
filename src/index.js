// @dotrino/lobby
// Lobby + matchmaking reciclable para juegos del ecosistema Dotrino.
// Construido sobre los pilares compartidos: proxy (transporte/canales/identify),
// identity (vault/firma/contactos) y reputation (web-of-trust).

export { createLobby, Lobby } from './lobby.js'
export { Room, STATUS, SEAT } from './room.js'
export { createEngine } from './engine.js'
export { Transport } from './transport.js'
export {
  createRepGate, rankRooms, ratePlayer,
  receiptPayload, signReceiptHalf
} from './reputation.js'
export { K, discoveryChannel, roomChannel, envelope, parseEnvelope } from './protocol.js'
export { Emitter, mulberry32, hashSeed, shuffle, normalizeSeats, samePubkey } from './util.js'
