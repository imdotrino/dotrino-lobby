import { test } from 'node:test'
import assert from 'node:assert/strict'
import { envelope, parseEnvelope, discoveryChannel, roomChannel, setLobbyHomeNode, K } from '../src/protocol.js'

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

test('nombres de canal: llevan delante el proxio que los hospeda', () => {
  // El descubrimiento es uno solo para todo el ecosistema, así que vive en un
  // nodo fijo: si cada quien lo publicara en el suyo habría tantas listas de
  // salas como proxios.
  assert.equal(discoveryChannel('chess'), 'P1/cclobby/chess')

  // La sala vive donde está su host, y eso se lee del propio roomId: el roomId
  // ES la instancia del host, y las instancias llevan delante su prefijo de nodo.
  assert.equal(roomChannel('chess', 'M2abc123'), 'M2/ccroom/chess/M2abc123')

  // Un roomId sin prefijo (dev, o un proxio sin identidad) se queda local.
  assert.equal(roomChannel('chess', 'tk1'), 'ccroom/chess/tk1')
})

test('el nodo del descubrimiento se puede cambiar para una malla propia', () => {
  setLobbyHomeNode('M2')
  assert.equal(discoveryChannel('chess'), 'M2/cclobby/chess')
  setLobbyHomeNode(null)
  assert.equal(discoveryChannel('chess'), 'cclobby/chess', 'sin nodo, canal local como antes')
  setLobbyHomeNode('P1')
})
