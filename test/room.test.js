import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLobby } from '../src/lobby.js'
import { MockHub, fakeIdentity, tick } from './helpers.js'

const counter = {
  initialState: { scores: {}, target: 3 },
  reducer: (s, a, ctx) => {
    if (a && a.bad) throw new Error('bad-move')
    const scores = { ...s.scores }
    scores[ctx.seat] = (scores[ctx.seat] || 0) + (a.inc || 1)
    return { ...s, scores }
  },
  isOver: (s) => { for (const [seat, v] of Object.entries(s.scores)) if (v >= s.target) return { winner: seat, reason: 'reached' }; return null }
}

async function setup (engine, extra = {}) {
  const hub = new MockHub()
  const idA = fakeIdentity('PKA', 'Ana'), idB = fakeIdentity('PKB', 'Beto')
  const epA = hub.endpoint({ identity: idA }), epB = hub.endpoint({ identity: idB })
  const base = { gameId: 'g', seats: ['p1', 'p2'], engine, requireVerify: false, start: 'full', ...extra }
  const lobbyA = await createLobby({ ...base, transport: epA, identity: idA })
  const lobbyB = await createLobby({ ...base, transport: epB, identity: idB })
  return { hub, idA, idB, epA, epB, lobbyA, lobbyB }
}

test('flujo: unir, sentarse, autostart, acción sincronizada, rechazo', async () => {
  const { lobbyA, lobbyB } = await setup(counter)
  const host = await lobbyA.createRoom({ name: 'Sala', playerName: 'Ana' })
  const guest = await lobbyB.joinRoom(host.roomId, { playerName: 'Beto' })
  await tick()

  // El guest recibe el estado inicial (waiting) con sus asientos.
  assert.equal(guest.status, 'waiting')
  assert.ok(guest.seats.p1 && guest.seats.p2)

  host.takeSeat('p1')
  guest.takeSeat('p2')
  await tick()

  assert.equal(host.status, 'playing')
  assert.equal(guest.status, 'playing')
  assert.equal(host.mySeat, 'p1')
  assert.equal(guest.mySeat, 'p2')

  guest.action({ inc: 1 })
  await tick()
  assert.equal(host.game.scores.p2, 1)
  assert.equal(guest.game.scores.p2, 1)

  let rejected = null
  guest.on('rejected', d => { rejected = d })
  guest.action({ bad: true })
  await tick()
  assert.ok(rejected, 'la acción inválida debe rechazarse')
  assert.equal(guest.game.scores.p2, 1) // sin cambios
})

test('fin de partida: isOver dispara ended + result', async () => {
  const { lobbyA, lobbyB } = await setup(counter)
  const host = await lobbyA.createRoom()
  const guest = await lobbyB.joinRoom(host.roomId)
  await tick()
  host.takeSeat('p1'); guest.takeSeat('p2'); await tick()

  let endedHost = null, endedGuest = null
  host.on('ended', r => { endedHost = r })
  guest.on('ended', r => { endedGuest = r })
  host.action({ inc: 3 }) // p1 llega a 3
  await tick()
  assert.equal(host.status, 'ended')
  assert.equal(guest.status, 'ended')
  assert.deepEqual(endedHost, { winner: 'p1', reason: 'reached' })
  assert.deepEqual(endedGuest, { winner: 'p1', reason: 'reached' })
})

test('info oculta: cada asiento sólo ve su mano', async () => {
  const cards = {
    initialState: { hands: { p1: ['A', 'B'], p2: ['C', 'D'] }, table: [] },
    reducer: (s) => s,
    view: (s, seat) => ({ table: s.table, myHand: seat ? s.hands[seat] : null, counts: { p1: s.hands.p1.length, p2: s.hands.p2.length } })
  }
  const { lobbyA, lobbyB } = await setup(cards)
  const host = await lobbyA.createRoom()
  const guest = await lobbyB.joinRoom(host.roomId)
  await tick()
  host.takeSeat('p1'); guest.takeSeat('p2'); await tick()

  assert.deepEqual(host.game.myHand, ['A', 'B'])
  assert.deepEqual(guest.game.myHand, ['C', 'D'])
  assert.equal(guest.game.hands, undefined, 'no se filtra el estado completo al guest')
  assert.deepEqual(guest.game.counts, { p1: 2, p2: 2 })
})

test('espectador no puede actuar; dejar asiento vuelve a espectador', async () => {
  const { lobbyA, lobbyB } = await setup(counter, { onSeatVacated: 'pause' })
  const host = await lobbyA.createRoom()
  const guest = await lobbyB.joinRoom(host.roomId)
  await tick()
  host.takeSeat('p1'); guest.takeSeat('p2'); await tick()
  assert.equal(host.status, 'playing')

  guest.leaveSeat()
  await tick()
  assert.equal(guest.mySeat, null)
  assert.equal(host.seats.p2.occupied, false)
  assert.equal(host.status, 'paused') // < min jugadores → pausa

  // Ahora como espectador, su acción no debe aplicar.
  guest.action({ inc: 5 })
  await tick()
  assert.equal(host.game.scores.p2 || 0, 0)
})

test('reconexión: reclamo de asiento por pubkey reanuda la partida', async () => {
  const { hub, idB, lobbyA, lobbyB } = await setup(counter, { onSeatVacated: 'pause' })
  const host = await lobbyA.createRoom()
  const guest = await lobbyB.joinRoom(host.roomId)
  await tick()
  host.takeSeat('p1'); guest.takeSeat('p2'); await tick()
  assert.equal(host.status, 'playing')

  // Cae el guest.
  hub.disconnect(guest.transport.token)
  await tick()
  assert.equal(host.seats.p2.status, 'disconnected')
  assert.equal(host.status, 'paused')

  // Reconecta con la MISMA identidad (pubkey PKB) y nuevo token.
  const epB2 = hub.endpoint({ identity: idB })
  const lobbyB2 = await createLobby({ gameId: 'g', seats: ['p1', 'p2'], engine: counter, requireVerify: false, start: 'full', transport: epB2, identity: idB })
  const guest2 = await lobbyB2.joinRoom(host.roomId, { playerName: 'Beto' })
  await tick()

  assert.equal(host.seats.p2.status, 'occupied', 'el asiento se reclama por pubkey')
  assert.equal(host.status, 'playing', 'la partida se reanuda')
  assert.equal(guest2.mySeat, 'p2')
})

test('grace: si nadie reclama, el asiento se libera', async () => {
  const { hub, lobbyA, lobbyB } = await setup(counter, { onSeatVacated: 'pause', disconnectGraceMs: 30 })
  const host = await lobbyA.createRoom()
  const guest = await lobbyB.joinRoom(host.roomId)
  await tick()
  host.takeSeat('p1'); guest.takeSeat('p2'); await tick()

  hub.disconnect(guest.transport.token)
  await new Promise(r => setTimeout(r, 80))
  assert.equal(host.seats.p2.status, 'open', 'tras el grace el asiento queda libre')
})

test('forfeit: dejar el asiento en partida termina a favor del otro', async () => {
  const { lobbyA, lobbyB } = await setup(counter, { onSeatVacated: 'forfeit' })
  const host = await lobbyA.createRoom()
  const guest = await lobbyB.joinRoom(host.roomId)
  await tick()
  host.takeSeat('p1'); guest.takeSeat('p2'); await tick()
  assert.equal(host.status, 'playing')

  guest.leaveSeat()
  await tick()
  assert.equal(host.status, 'ended')
  assert.deepEqual(host.result, { winner: 'p1', reason: 'forfeit' })
})

test('discovery + quickMatch', async () => {
  const { lobbyA, lobbyB } = await setup(counter)
  const host = await lobbyA.createRoom({ name: 'Sala 1' })
  host.takeSeat('p1')
  await tick()

  const rooms = await lobbyB.listRooms({ timeout: 80 })
  assert.equal(rooms.length, 1)
  assert.equal(rooms[0].roomId, host.roomId)
  assert.equal(rooms[0].openSeats, 1)
  assert.equal(rooms[0].name, 'Sala 1')

  const room = await lobbyB.quickMatch({ timeout: 80, seat: 'p2' })
  await tick()
  assert.equal(room.isHost, false)
  assert.equal(room.mySeat, 'p2')
  assert.equal(host.status, 'playing')
})

test('resultado co-firmado para ELO (host gana → winner "a", ambos firman)', async () => {
  const { lobbyA, lobbyB } = await setup(counter)
  const host = await lobbyA.createRoom()
  const guest = await lobbyB.joinRoom(host.roomId)
  await tick()
  host.takeSeat('p1'); guest.takeSeat('p2'); await tick()
  let hr = null, gr = null
  host.on('result', r => { hr = r })
  guest.on('result', r => { gr = r })
  host.action({ inc: 3 }) // p1 (host) gana
  await tick(8)
  assert.ok(hr && gr, 'host y guest emiten result')
  assert.equal(hr.outcome, 'a', 'el host (a) ganó')
  assert.equal(gr.outcome, 'a')
  assert.ok(hr.coSigned.sigA && hr.coSigned.sigB, 'co-firma completa (ambas mitades)')
  assert.equal(hr.coSigned.data.op, 'event')
  assert.equal(hr.coSigned.data.indicator, 'elo')
  assert.equal(hr.coSigned.data.scope, 'g')
})

test('reconexión del HOST: HOST_REKEY mantiene viva la partida para los guests', async () => {
  const { lobbyA, lobbyB } = await setup(counter, { onSeatVacated: 'pause' })
  const host = await lobbyA.createRoom()
  const guest = await lobbyB.joinRoom(host.roomId)
  await tick()
  host.takeSeat('p1'); guest.takeSeat('p2'); await tick()
  assert.equal(host.status, 'playing')

  let closed = false
  guest.on('closed', () => { closed = true })

  // El host reconecta con token nuevo (cae el viejo y llega HOST_REKEY).
  host.transport.reconnect('host-new-token')
  await tick(12)

  assert.equal(host.roomId, 'host-new-token')
  assert.equal(guest.roomId, 'host-new-token', 'el guest se re-clavó al token nuevo')
  assert.equal(closed, false, 'el guest NO debe cerrar: el host reconectó dentro del grace')
  assert.equal(guest.status, 'playing')

  // La partida sigue: una acción del host llega al guest.
  host.action({ inc: 1 })
  await tick(12)
  assert.equal(guest.game.scores.p1, 1, 'la acción del host se propaga tras la reconexión')
})

test('sin identidad: mySeat funciona por mySeatId del snapshot', async () => {
  const hub = new MockHub()
  const epA = hub.endpoint(), epB = hub.endpoint() // sin identidad
  const base = { gameId: 'g', seats: ['p1', 'p2'], engine: counter, requireVerify: false, start: 'full' }
  const lobbyA = await createLobby({ ...base, transport: epA })
  const lobbyB = await createLobby({ ...base, transport: epB })
  const host = await lobbyA.createRoom()
  const guest = await lobbyB.joinRoom(host.roomId)
  await tick()
  host.takeSeat('p1'); guest.takeSeat('p2'); await tick()
  assert.equal(host.mySeat, 'p1')
  assert.equal(guest.mySeat, 'p2', 'mySeat se resuelve por mySeatId aun sin pubkey')
  assert.equal(host.status, 'playing')
})

test('recibo de partida co-firmado (con verify)', async () => {
  const { lobbyA, lobbyB } = await setup({ ...counter, initialState: { scores: {}, target: 1 } }, { requireVerify: true })
  const host = await lobbyA.createRoom()
  const guest = await lobbyB.joinRoom(host.roomId)
  await tick(10)
  host.takeSeat('p1'); guest.takeSeat('p2')
  await tick(10)
  assert.equal(host.status, 'playing')

  host.action({ inc: 1 }) // p1 gana (target 1)
  await tick(10)
  assert.equal(host.status, 'ended')

  const rHost = host.matchReceipt('PKB')
  const rGuest = guest.matchReceipt('PKA')
  assert.ok(rHost && rHost.sigA && rHost.sigB, 'host tiene recibo completo')
  assert.ok(rGuest && rGuest.sigA && rGuest.sigB, 'guest tiene recibo completo')
  assert.equal(rHost.ts, rGuest.ts, 'mismo ts en ambas mitades')
})
