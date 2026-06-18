import { test } from 'node:test'
import assert from 'node:assert/strict'
import { envelope, parseEnvelope, discoveryChannel, roomChannel, K } from '../src/protocol.js'

test('envelope/parse roundtrip', () => {
  const env = envelope('chess', 'tk1', K.STATE, { foo: 1 }, 5)
  assert.equal(env.__ccl, 1)
  const p = parseEnvelope(env)
  assert.deepEqual(p, { g: 'chess', r: 'tk1', k: K.STATE, d: { foo: 1 }, s: 5 })
})

test('parseEnvelope acepta string JSON y rechaza lo ajeno', () => {
  const env = envelope('g', 'r', K.HELLO, { a: 1 })
  assert.ok(parseEnvelope(JSON.stringify(env)))
  assert.equal(parseEnvelope({ hello: 'world' }), null)        // sin __ccl
  assert.equal(parseEnvelope('no-json'), null)
  assert.equal(parseEnvelope({ __ccl: 1 }), null)              // sin k
  assert.equal(parseEnvelope(null), null)
})

test('parseEnvelope no colisiona con el tag WebRTC', () => {
  // El cliente proxy intercepta parsed.t === '__cc_rtc__'; nuestro sobre usa `k`.
  const env = envelope('g', 'r', K.ACTION, {})
  assert.equal(env.t, undefined)
})

test('nombres de canal', () => {
  assert.equal(discoveryChannel('chess'), 'cclobby/chess')
  assert.equal(roomChannel('chess', 'tk1'), 'ccroom/chess/tk1')
})
