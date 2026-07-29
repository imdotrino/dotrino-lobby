import { test } from 'node:test'
import assert from 'node:assert/strict'
import { envelope, parseEnvelope, discoveryChannel, discoveryChannels, roomChannel, K } from '../src/protocol.js'

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

// Ids con el alfabeto vigente del proxio (sin I L S Z B G).
const ID_A = '3PQ2QE8YMD8J'
const ID_B = 'RAEKMT36F81J'

test('la SALA vive en el proxio de su host, leído del propio roomId', () => {
  // El roomId ES la instancia del host, y las instancias llevan delante el id de
  // su nodo: nadie tiene que declarar ni acordar dónde vive la sala.
  assert.equal(roomChannel('chess', ID_B + 'abc123'), ID_B + '/ccroom/chess/' + ID_B + 'abc123')

  // Un roomId sin id de nodo (dev, o un proxio sin identidad) se queda local.
  assert.equal(roomChannel('chess', 'tk1'), 'ccroom/chess/tk1')
})

test('el DESCUBRIMIENTO tiene un canal por nodo: se publica en uno y se lee de todos', () => {
  // No tiene dueño natural —es un nombre global del ecosistema—, así que en vez
  // de designar un árbitro cada proxio guarda su lista y quien busca las mezcla.
  assert.deepEqual(discoveryChannels('chess', [ID_A, ID_B]), [
    ID_A + '/cclobby/chess',
    ID_B + '/cclobby/chess'
  ])

  // Se publica en UNO: el del proxio al que uno está conectado.
  assert.equal(discoveryChannel('chess', ID_A), ID_A + '/cclobby/chess')
})

test('el descubrimiento degrada a canal local si no hay ids de nodo', () => {
  // Proxio sin identidad, o desarrollo: comportamiento de siempre.
  assert.deepEqual(discoveryChannels('chess', []), ['cclobby/chess'])
  assert.equal(discoveryChannel('chess', null), 'cclobby/chess')
  // Un id mal formado no cuenta: dejaría un canal que no es de nadie.
  assert.deepEqual(discoveryChannels('chess', ['P1']), ['cclobby/chess'])
})

test('los ids repetidos no generan consultas duplicadas', () => {
  assert.deepEqual(discoveryChannels('chess', [ID_A, ID_A, ID_B]), [
    ID_A + '/cclobby/chess',
    ID_B + '/cclobby/chess'
  ])
})
