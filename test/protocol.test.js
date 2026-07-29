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

const ID_A = '3PQ2QE8ZMD8J'   // ids de nodo reales: 12 chars del alfabeto
const ID_B = 'RAEKMT36F81J'

test('nombres de canal: llevan delante el proxio que los hospeda', () => {
  // La sala vive donde está su host, y eso se lee del propio roomId: el roomId
  // ES la instancia del host, y las instancias llevan delante el id de su nodo.
  assert.equal(roomChannel('chess', ID_B + 'abc123'), ID_B + '/ccroom/chess/' + ID_B + 'abc123')

  // Un roomId sin id de nodo (dev, o un proxio sin identidad) se queda local.
  assert.equal(roomChannel('chess', 'tk1'), 'ccroom/chess/tk1')

  // Sin nodo de descubrimiento fijado, el canal es local a cada proxio.
  assert.equal(discoveryChannel('chess'), 'cclobby/chess')
})

test('el nodo del descubrimiento se fija con el id del proxio elegido', () => {
  setLobbyHomeNode(ID_A)
  assert.equal(discoveryChannel('chess'), ID_A + '/cclobby/chess')
  // Un id mal formado NO se acepta: dejaría un canal que no es de nadie.
  setLobbyHomeNode('P1')
  assert.equal(discoveryChannel('chess'), 'cclobby/chess')
  setLobbyHomeNode(null)
})
