// DE PUNTA A PUNTA, POR UN SOCKET DE VERDAD.
//
// Dos clientes de Node (`@dotrino/proxy-client` real, no un mock) contra un proxio que
// apunta CADA TRAMA en los dos sentidos. Se juega una partida entera —descubrir la sala,
// entrar, verificar identidad, sentarse, turnos, chat, invitación— y después se mira lo
// que el proxio pudo leer.
//
// Esta es la prueba que vale: el mock del otro archivo comprueba la lógica, y este
// comprueba el CABLE. Si algo se lee aquí, se lee en el VPS.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketProxyClient } from '@dotrino/proxy-client'
import { createLobby } from '../src/lobby.js'
import { K, parseEnvelope } from '../src/protocol.js'
import { startProxio } from './proxio.mjs'
import { bovedaDeMentira } from './boveda.mjs'

const counter = {
  initialState: { scores: {}, target: 2 },
  reducer: (s, a, ctx) => {
    const scores = { ...s.scores }
    scores[ctx.seat] = (scores[ctx.seat] || 0) + (a.inc || 1)
    return { ...s, scores }
  },
  isOver: (s) => { for (const [seat, v] of Object.entries(s.scores)) if (v >= s.target) return { winner: seat, reason: 'reached' }; return null }
}

/** Espera activa: los tiempos de un socket no son los de un microtask. */
async function hasta (fn, { ms = 5000, cada = 15 } = {}) {
  const fin = Date.now() + ms
  while (Date.now() < fin) {
    let v
    try { v = await fn() } catch (_) { v = false }
    if (v) return v
    await new Promise(r => setTimeout(r, cada))
  }
  throw new Error('se agotó la espera')
}

async function jugador (url, nickname, extra = {}) {
  const identity = await bovedaDeMentira(nickname)
  const proxy = new WebSocketProxyClient({ url, enableWebRTC: false, autoReconnect: false, enableHeartbeat: false })
  const lobby = await createLobby({
    gameId: 'e2e', seats: ['p1', 'p2'], engine: counter,
    proxy, identity, requireVerify: true, start: 'full', ...extra
  })
  return { identity, proxy, lobby }
}

/** Los sobres dirigidos que pasaron por el proxio, tal cual los vio. */
function dirigidos (proxio) {
  return proxio.frames
    .filter(f => f.dir === 'out' && f.frame.type === 'message')
    .map(f => { try { return JSON.parse(f.frame.message) } catch (_) { return null } })
    .filter(Boolean)
}

test('partida completa por el cable: el proxio no puede leer nada del usuario', async (t) => {
  const proxio = await startProxio()
  const SALA = 'Mesa-secreta-de-Ana-7431'
  const CHAT = 'jaque-en-tres-9925'

  const ana = await jugador(proxio.url, 'Ana-8812')
  const beto = await jugador(proxio.url, 'Beto-5540')
  t.after(async () => { ana.proxy.close(); beto.proxy.close(); await proxio.stop() })

  // 1. La sala se descubre por el canal público (tokens), y el RESUMEN llega sellado.
  const host = await ana.lobby.createRoom({ name: SALA, playerName: 'Ana-8812' })
  const salas = await hasta(async () => {
    const r = await beto.lobby.listRooms({ timeout: 800, enrich: false })
    return r.length ? r : false
  })
  assert.equal(salas[0].name, SALA, 'el resumen llega y se entiende')
  assert.ok(salas[0].hostPubkey, 'y trae la identidad del host')

  // 2. Con esa identidad, el saludo ya sale sellado desde el primer mensaje.
  const guest = await beto.lobby.joinRoom(salas[0].roomId, { playerName: 'Beto-5540', hostPubkey: salas[0].hostPubkey })

  // 3. Verificación de identidad (reto/respuesta firmado) + asientos + arranque.
  host.takeSeat('p1')
  await hasta(() => guest.seats && guest.seats.p1 && guest.seats.p1.occupied)
  guest.takeSeat('p2')
  await hasta(() => host.status === 'playing' && guest.status === 'playing')

  // 4. Turnos de verdad hasta que hay ganador.
  const chats = []
  guest.on('chat', (c) => chats.push(c))
  host.chat(CHAT)
  guest.action({ inc: 1 })
  await hasta(() => host.game && host.game.scores.p2 === 1)
  host.action({ inc: 1 })
  await hasta(() => guest.game && guest.game.scores.p1 === 1)
  guest.action({ inc: 1 })
  await hasta(() => host.status === 'ended' && guest.status === 'ended')

  assert.equal(host.result.winner, 'p2')
  assert.equal(guest.result.winner, 'p2', 'los dos ven el mismo resultado')
  await hasta(() => chats.some(c => c.text === CHAT))

  // 5. Una invitación por pubkey (la que usa la cola offline).
  await ana.lobby.inviteContact(beto.identity.me.publickey, { roomId: host.roomId, name: SALA })
  await hasta(() => proxio.frames.some(f => f.dir === 'in' && f.frame.to_publickey))

  // ── LO QUE VIO EL PROXIO ────────────────────────────────────────────────
  const visto = proxio.text()
  // Entre comillas: el tipo exacto, no un trozo suelto. `K.HELLO` ('hello') aparecería
  // dentro de `__cc_hello__`, que es la trama de control del transporte y sí va en claro.
  for (const secreto of [SALA, CHAT, 'Ana-8812', 'Beto-5540', 'scores', `"${K.ACTION}"`, `"${K.CHAT}"`, `"${K.STATE}"`, `"${K.INVITE}"`, `"${K.HELLO}"`]) {
    assert.equal(visto.includes(secreto), false, `el proxio no puede ver «${secreto}»`)
  }

  // Y de lo dirigido, lo único legible es el SALUDO DEL TRANSPORTE: una llave pública,
  // que el proxio ya tenía atada a esa conexión desde el `identify`.
  const sobres = dirigidos(proxio)
  assert.ok(sobres.length > 12, `hubo tráfico de verdad (${sobres.length} mensajes)`)
  let sellados = 0
  for (const s of sobres) {
    if (s && s.t === '__cc_hello__') {
      assert.deepEqual(Object.keys(s).sort(), ['publickey', 't'], 'el saludo no lleva nada más')
      continue
    }
    const env = parseEnvelope(s)
    assert.equal(env, null, `esto se puede leer y no debería: ${JSON.stringify(s).slice(0, 80)}`)
    sellados++
  }
  assert.ok(sellados > 10, `y todo lo de la sala va sellado (${sellados} de ${sobres.length})`)
})

test('entrar por enlace (sin saber quién es el host): la presentación lo resuelve por el cable', async (t) => {
  const proxio = await startProxio()
  const ana = await jugador(proxio.url, 'Ana')
  const beto = await jugador(proxio.url, 'Beto')
  t.after(async () => { ana.proxy.close(); beto.proxy.close(); await proxio.stop() })

  const host = await ana.lobby.createRoom({ name: 'Directa', playerName: 'Ana' })
  // Un enlace compartido solo trae el token: no se sabe a qué identidad sellarle.
  const guest = await beto.lobby.joinRoom(host.roomId, { playerName: 'Beto' })

  await hasta(() => guest.state && guest.state.hostPubkey)
  assert.equal(guest.hostPubkey, ana.identity.me.publickey, 'el saludo del transporte dice quién es el host')

  host.takeSeat('p1')
  await hasta(() => guest.seats && guest.seats.p1 && guest.seats.p1.occupied)
  guest.takeSeat('p2')
  await hasta(() => host.status === 'playing' && guest.status === 'playing')
  assert.equal(guest.mySeat, 'p2')

  // El saludo es lo único en claro, y no dice nada del usuario.
  for (const s of dirigidos(proxio)) {
    if (s && s.t === '__cc_hello__') continue
    assert.equal(parseEnvelope(s), null, 'todo lo de la sala va sellado')
  }
})

test('el proxio inyecta una jugada EN CLARO y la sala no se la traga', async (t) => {
  const proxio = await startProxio()
  const ana = await jugador(proxio.url, 'Ana')
  const beto = await jugador(proxio.url, 'Beto')
  t.after(async () => { ana.proxy.close(); beto.proxy.close(); await proxio.stop() })

  const host = await ana.lobby.createRoom({ playerName: 'Ana' })
  const guest = await beto.lobby.joinRoom(host.roomId, { playerName: 'Beto', hostPubkey: ana.identity.me.publickey })
  host.takeSeat('p1')
  await hasta(() => guest.seats && guest.seats.p1 && guest.seats.p1.occupied)
  guest.takeSeat('p2')
  await hasta(() => host.status === 'playing')

  // Quien opera el proxio ve pasar los tokens y conoce la sala: puede colarle al host una
  // trama a nombre del guest. Lo que no puede es sellarla — no tiene la llave. Se inyecta
  // DESDE EL SERVIDOR, que es de donde vendría: el cliente del guest ya no sabe mandar en
  // claro (`requireSealed`), y por eso hace falta el proxio para intentarlo.
  proxio.inject(host.roomId, beto.proxy.token, { __ccl: 1, g: 'e2e', r: host.roomId, k: K.ACTION, d: { action: { inc: 99 } } })
  await new Promise(r => setTimeout(r, 250))
  assert.equal(host.game.scores.p2, undefined, 'la jugada en claro no entró')
  assert.equal(host.status, 'playing', 'y la partida sigue igual')
})
