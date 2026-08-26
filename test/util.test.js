import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mulberry32, hashSeed, shuffle, normalizeSeats, samePubkey } from '../src/util.js'
import { rankRooms } from '../src/reputation.js'

test('mulberry32 es determinista por semilla', () => {
  const a = mulberry32(123), b = mulberry32(123), c = mulberry32(124)
  const seqA = [a(), a(), a()], seqB = [b(), b(), b()]
  assert.deepEqual(seqA, seqB)
  assert.notDeepEqual(seqA, [c(), c(), c()])
  for (const v of seqA) { assert.ok(v >= 0 && v < 1) }
})

test('shuffle determinista con rng sembrado', () => {
  const r1 = mulberry32(7), r2 = mulberry32(7)
  const a = shuffle([1, 2, 3, 4, 5, 6], r1)
  const b = shuffle([1, 2, 3, 4, 5, 6], r2)
  assert.deepEqual(a, b)
  assert.deepEqual([...a].sort(), [1, 2, 3, 4, 5, 6])
})

test('hashSeed estable', () => {
  assert.equal(hashSeed('chess'), hashSeed('chess'))
  assert.notEqual(hashSeed('a'), hashSeed('b'))
})

test('normalizeSeats nombrados y por rango', () => {
  const named = normalizeSeats(['white', 'black'])
  assert.deepEqual(named.ids, ['white', 'black'])
  assert.equal(named.min, 2); assert.equal(named.max, 2); assert.equal(named.named, true)

  const ranged = normalizeSeats({ min: 2, max: 4 })
  assert.deepEqual(ranged.ids, ['s1', 's2', 's3', 's4'])
  assert.equal(ranged.min, 2); assert.equal(ranged.max, 4); assert.equal(ranged.named, false)
})

test('samePubkey compara por x/y/crv', () => {
  const a = JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'XX', y: 'YY' })
  const b = JSON.stringify({ crv: 'P-256', x: 'XX', y: 'YY', kty: 'EC' }) // otro orden
  assert.ok(samePubkey(a, b))
  assert.ok(!samePubkey(a, JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'ZZ', y: 'YY' })))
  assert.ok(!samePubkey(null, b))
})

test('rankRooms ordena igual venga como venga la lista (empate a score)', async () => {
  // Sin desempate, dos salas con el mismo score quedan en el orden en que
  // contestaron al INFO — una carrera de red — y la lista pública baila.
  const rooms = [{ roomId: 'b2' }, { roomId: 'a1' }, { roomId: 'c3' }]
  const uno = await rankRooms(rooms)
  const otro = await rankRooms([...rooms].reverse())
  assert.deepEqual(uno.map(r => r.roomId), ['a1', 'b2', 'c3'])
  assert.deepEqual(otro.map(r => r.roomId), uno.map(r => r.roomId))
})

test('rankRooms: el score y los contactos siguen mandando sobre el desempate', async () => {
  const pk = (x) => JSON.stringify({ kty: 'EC', crv: 'P-256', x, y: 'YY' })
  const contacto = pk('XX')
  const rooms = [
    { roomId: 'a1', hostPubkey: pk('A') },
    { roomId: 'b2', hostPubkey: contacto },
    { roomId: 'c3', hostPubkey: pk('C') }
  ]
  const contacts = new Set([contacto])
  const conContacto = await rankRooms(rooms, { contacts })
  assert.equal(conContacto[0].roomId, 'b2') // el contacto primero, aunque 'a1' ordene antes
  const reputation = { reputationOf: async (k) => (k === contacto ? { score: 0 } : { score: 90 }) }
  const porScore = await rankRooms(rooms, { reputation, contacts, preferContacts: false })
  assert.deepEqual(porScore.map(r => r.roomId), ['a1', 'c3', 'b2'])
})
