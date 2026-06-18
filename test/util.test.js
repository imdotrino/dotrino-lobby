import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mulberry32, hashSeed, shuffle, normalizeSeats, samePubkey } from '../src/util.js'

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
