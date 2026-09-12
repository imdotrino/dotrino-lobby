// LO QUE VE QUIEN OPERA EL PROXIO.
//
// El proxio no cifra: `send`/`sendByPubkey` mandan el payload tal cual. Hasta 0.7.0 esta
// librería hablaba así, y por ahí pasaban el chat, las jugadas, el nombre de la sala y el
// apodo de cada jugador. CONVENCIONES §4.1 lo llama por su nombre: es un agujero abierto.
//
// `hub.wire` es exactamente la vista del proxio (lo que se le entrega para que lo enrute),
// así que estas pruebas no comprueban "que funcione": comprueban que POR AHÍ NO PASA NADA.
//
// El sellado es de verdad (ECDH P-256 + AES-GCM de `@dotrino/identity`), no simulado.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLobby } from '../src/lobby.js'
import { K } from '../src/protocol.js'
import * as publico from '../src/index.js'
import { MockHub, fakeIdentity, tick, HELLO_TAG } from './helpers.js'

const counter = {
  initialState: { scores: {}, target: 3 },
  reducer: (s, a, ctx) => {
    const scores = { ...s.scores }
    scores[ctx.seat] = (scores[ctx.seat] || 0) + (a.inc || 1)
    return { ...s, scores }
  },
  isOver: (s) => { for (const [seat, v] of Object.entries(s.scores)) if (v >= s.target) return { winner: seat, reason: 'reached' }; return null }
}

async function dosLobbies (hub, extra = {}) {
  const idA = fakeIdentity('PKA', 'Ana'), idB = fakeIdentity('PKB', 'Beto')
  const epA = hub.endpoint({ identity: idA }), epB = hub.endpoint({ identity: idB })
  const base = { gameId: 'g', seats: ['p1', 'p2'], engine: counter, requireVerify: false, start: 'full', ...extra }
  const lobbyA = await createLobby({ ...base, transport: epA, identity: idA })
  const lobbyB = await createLobby({ ...base, transport: epB, identity: idB })
  return { idA, idB, epA, epB, lobbyA, lobbyB }
}

/** Todo lo que el proxio pudo leer, como texto. */
const legible = (hub) => hub.plaintext.map(p => JSON.stringify(p)).join('\n')

// ───────────────────────────────────────────────────────────────────────────
// 0. La puerta del paquete
// ───────────────────────────────────────────────────────────────────────────

// `src/index.d.ts` llegó a declarar cosas que `src/index.js` no exportaba: los tipos
// decían que sí y en marcha era `undefined`. Lo cazó una prueba contra el paquete ya
// publicado, que es tarde — así que ahora se mira la puerta del paquete, no solo los
// módulos de dentro.
test('el paquete exporta lo que dice exportar', () => {
  for (const nombre of ['createLobby', 'Lobby', 'Room', 'Transport', 'createEngine', 'K', 'envelope', 'parseEnvelope', 'roomChannel', 'discoveryChannel']) {
    assert.ok(publico[nombre], `falta el export ${nombre}`)
  }
  assert.equal(typeof publico.createLobby, 'function')
  assert.equal(publico.K.CHAT, 'chat')
})

// ───────────────────────────────────────────────────────────────────────────
// 1. Una partida entera: nada del usuario queda legible
// ───────────────────────────────────────────────────────────────────────────

test('partida completa: por el proxio no pasa ni el chat, ni las jugadas, ni los apodos', async () => {
  const hub = new MockHub()
  const { lobbyA, lobbyB } = await dosLobbies(hub)

  const host = await lobbyA.createRoom({ name: 'La sala secreta de Ana', playerName: 'Ana' })
  const guest = await lobbyB.joinRoom(host.roomId, { playerName: 'Beto' })
  await tick()

  host.takeSeat('p1'); guest.takeSeat('p2')
  await tick()
  assert.equal(host.status, 'playing', 'la partida arranca')
  assert.equal(guest.status, 'playing')

  // Turnos de verdad, hasta que hay ganador.
  const chats = []
  guest.on('chat', (c) => chats.push(c))
  host.chat('te voy ganando')
  guest.action({ inc: 1 }); await tick()
  host.action({ inc: 1 }); await tick()
  guest.action({ inc: 2 }); await tick()

  assert.equal(host.status, 'ended', 'la partida termina de verdad')
  assert.equal(host.result.winner, 'p2')
  assert.equal(guest.result.winner, 'p2', 'el guest ve el mismo resultado')
  assert.ok(chats.some(c => c.text === 'te voy ganando'), 'el chat llega')

  const visto = legible(hub)
  for (const secreto of ['te voy ganando', 'La sala secreta de Ana', 'Ana', 'Beto', 'scores', K.ACTION, K.CHAT, K.STATE, K.EVENT]) {
    assert.equal(visto.includes(secreto), false, `el proxio no puede ver «${secreto}»`)
  }
  assert.ok(hub.wire.length > 10, 'hubo tráfico de verdad, no una sala vacía')
})

// ───────────────────────────────────────────────────────────────────────────
// 2. De esta librería no sale NADA sin sellar; lo único en claro es el saludo
//    del transporte, que lleva llaves públicas
// ───────────────────────────────────────────────────────────────────────────

test('de la sala no sale nada sin sellar: en claro solo el saludo del transporte', async () => {
  const hub = new MockHub()
  const { lobbyA, lobbyB } = await dosLobbies(hub)
  const host = await lobbyA.createRoom({ name: 'Sala', playerName: 'Ana' })
  await lobbyB.listRooms({ timeout: 200 })
  const guest = await lobbyB.joinRoom(host.roomId, { playerName: 'Beto' })
  await tick()
  guest.takeSeat('p2'); await tick()

  const claros = hub.plaintext
  assert.ok(claros.length > 0, 'alguien tiene que decir quién es antes de poder sellar')
  for (const p of claros) {
    assert.equal(p.t, HELLO_TAG, `en claro solo el saludo del transporte, no ${JSON.stringify(p).slice(0, 60)}`)
    // El saludo entero: una llave pública, que el proxio ya tiene desde el `identify`.
    assert.deepEqual(Object.keys(p).sort(), ['publickey', 't'])
    assert.ok(p.publickey === 'PKA' || p.publickey === 'PKB')
  }
  assert.equal(hub.plaintextNoHello.length, 0, 'ni un sobre de la sala en claro')
})

// ───────────────────────────────────────────────────────────────────────────
// 3. La invitación (por pubkey, cola offline) también va sellada
// ───────────────────────────────────────────────────────────────────────────

test('la invitación no enseña ni el nombre de la sala ni el apodo de quien invita', async () => {
  const hub = new MockHub()
  const { lobbyA, lobbyB, idB } = await dosLobbies(hub)
  await lobbyA.createRoom({ name: 'Partida de los viernes', playerName: 'Ana' })

  let invite = null
  lobbyB.on('invite', (i) => { invite = i })
  await lobbyA.inviteContact(idB.me.publickey, { roomId: lobbyA.transport.token, name: 'Partida de los viernes' })
  await tick()

  assert.ok(invite, 'la invitación llega')
  assert.equal(invite.name, 'Partida de los viernes')
  assert.equal(invite.from, 'PKA', 'trae la identidad del host: con ella se entra sellando desde el primer mensaje')

  const visto = legible(hub)
  assert.equal(visto.includes('Partida de los viernes'), false)
  assert.equal(visto.includes(K.INVITE), false)
})

// ───────────────────────────────────────────────────────────────────────────
// 4. El aviso de re-clave del host (HOST_REKEY) también va sellado
// ───────────────────────────────────────────────────────────────────────────

test('la re-clave del host va sellada: el proxio no sabe qué sala se mudó a qué token', async () => {
  const hub = new MockHub()
  const { lobbyA, lobbyB, epA } = await dosLobbies(hub)
  const host = await lobbyA.createRoom({ playerName: 'Ana' })
  const guest = await lobbyB.joinRoom(host.roomId, { playerName: 'Beto' })
  await tick()
  host.takeSeat('p1'); guest.takeSeat('p2'); await tick()

  const desde = hub.wire.length
  epA.reconnect('tkNUEVO')
  await tick()

  assert.equal(guest.roomId, 'tkNUEVO', 'el guest sigue al host a su token nuevo')
  const visto = hub.wire.slice(desde).filter(f => !JSON.stringify(f.payload).includes('sealed'))
  for (const f of visto) {
    const env = f.payload
    assert.notEqual(env && env.k, K.HOST_REKEY, 'la re-clave nunca sale en claro')
  }
})

// ───────────────────────────────────────────────────────────────────────────
// 5. Sellar solo de SALIDA no sirve: lo que llega sin sellar se tira
// ───────────────────────────────────────────────────────────────────────────

test('una jugada inyectada SIN SELLAR no entra en la partida', async () => {
  const hub = new MockHub()
  const { lobbyA, lobbyB, epB } = await dosLobbies(hub)
  const host = await lobbyA.createRoom({ playerName: 'Ana' })
  const guest = await lobbyB.joinRoom(host.roomId, { playerName: 'Beto' })
  await tick()
  host.takeSeat('p1'); guest.takeSeat('p2'); await tick()
  assert.equal(host.status, 'playing')

  // Un tercero (o el propio proxio) mete una jugada a nombre del asiento del guest,
  // en claro. Quien acepta texto plano se salta el sellado entero.
  const falsa = { __ccl: 1, g: 'g', r: host.roomId, k: K.ACTION, d: { action: { inc: 99 } } }
  hub.route(epB.token, host.roomId, falsa)
  await tick()

  assert.equal(host.game.scores.p2, undefined, 'la jugada en claro no se aplicó')

  // Y tampoco cuela un chat falso.
  const chats = []
  guest.on('chat', (c) => chats.push(c))
  hub.route(epB.token, host.roomId, { __ccl: 1, g: 'g', r: host.roomId, k: K.CHAT, d: { text: 'soy el proxio' } })
  await tick()
  assert.equal(chats.length, 0, 'el chat en claro no se difunde')
})

// ───────────────────────────────────────────────────────────────────────────
// 6. Sin la llave del otro lado se PARA, y se dice con su code
// ───────────────────────────────────────────────────────────────────────────

test('sin llave del otro lado no se manda nada: falla con su code, no cae a texto claro', async () => {
  const hub = new MockHub()
  const { lobbyA, lobbyB } = await dosLobbies(hub)
  const host = await lobbyA.createRoom({ playerName: 'Ana' })

  // El host "olvida" su llave: es lo que pasa con una punta que todavía no la anuncia
  // (una versión vieja del otro lado).
  hub.encPubs.delete('PKA')

  const guest = await lobbyB.joinRoom(host.roomId, { playerName: 'Beto', hostPubkey: 'PKA' })
  await tick()
  const fallos = []
  guest.on('event', (e) => { if (e.event === 'seal-failed') fallos.push(e.data) })
  guest.chat('esto no debería salir')
  await tick()

  assert.ok(fallos.some(f => f.code === 'no-encpub'), 'se dice por qué, y con el código del pilar')
  assert.equal(legible(hub).includes('esto no debería salir'), false, 'y no salió en claro')
})

// ───────────────────────────────────────────────────────────────────────────
// 7. El descubrimiento: el resumen de la sala viaja sellado
// ───────────────────────────────────────────────────────────────────────────

test('el resumen de la sala (nombre, apodos, asientos) llega sellado a quien pregunta', async () => {
  const hub = new MockHub()
  const { lobbyA, lobbyB } = await dosLobbies(hub)
  await lobbyA.createRoom({ name: 'Mesa de Ana', playerName: 'Ana' })
  await tick()

  const rooms = await lobbyB.listRooms({ timeout: 200, enrich: false })
  assert.equal(rooms.length, 1, 'la sala se descubre')
  assert.equal(rooms[0].name, 'Mesa de Ana')
  assert.equal(rooms[0].hostPubkey, 'PKA', 'el resumen trae la identidad del host')

  assert.equal(legible(hub).includes('Mesa de Ana'), false, 'el nombre de la sala no viaja en claro')
  assert.equal(hub.plaintextNoHello.length, 0, 'ni la pregunta ni el resumen salen en claro')
})
