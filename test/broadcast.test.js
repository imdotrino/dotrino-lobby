// EMISIÓN: UNO EMITE, LOS DEMÁS MIRAN.
//
// El hub sella de verdad y las identidades firman de verdad (`bovedaDeMentira`): lo que se
// comprueba aquí es que entra solo quien tiene el enlace, que lo que llega lo firmó el
// emisor, que el enlace sobrevive a que el emisor recargue y que por el proxio no pasa
// nada legible.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLobby } from '../src/lobby.js'
import { K, broadcastChannel, envelope } from '../src/protocol.js'
import * as publico from '../src/index.js'
import { encodeBroadcastRef, decodeBroadcastRef, newBroadcastRef } from '../src/broadcast.js'
import { MockHub, tick } from './helpers.js'
import { bovedaDeMentira } from './boveda.mjs'

async function hasta (fn, { ms = 3000, cada = 5 } = {}) {
  const fin = Date.now() + ms
  while (Date.now() < fin) {
    if (await fn()) return true
    await new Promise(r => setTimeout(r, cada))
  }
  throw new Error('se agotó la espera')
}

async function lobbyEn (hub, identity) {
  const ep = hub.endpoint({ identity })
  const lobby = await createLobby({ gameId: 'padel', transport: ep, identity })
  return { ep, lobby, identity }
}

/** Lo que el hub vio pasar, como texto: la vista de quien opera el proxio. */
const cable = (hub) => hub.wire.map(f => JSON.stringify(f.payload)).join('\n')

test('el paquete exporta la emisión', () => {
  for (const nombre of ['Broadcast', 'newBroadcastRef', 'encodeBroadcastRef', 'decodeBroadcastRef', 'broadcastChannel']) {
    assert.ok(publico[nombre], `falta el export ${nombre}`)
  }
})

test('la referencia va y vuelve por el enlace, y lo que no tiene su forma se rechaza con code', async () => {
  const id = await bovedaDeMentira('Ana')
  const ref = { ...newBroadcastRef('ABCDEFGH1234'), hostPubkey: id.me.publickey }
  assert.ok(ref.key.startsWith('ABCDEFGH1234'), 'la clave lleva delante el nodo')
  assert.equal(broadcastChannel('padel', ref.key), `ABCDEFGH1234/ccbcast/padel/${ref.key}`)
  assert.ok(newBroadcastRef(null).key.startsWith('_'), 'sin nodo no puede confundirse con uno')

  const vuelta = decodeBroadcastRef(encodeBroadcastRef(ref))
  assert.equal(vuelta.key, ref.key)
  assert.equal(vuelta.secret, ref.secret)
  assert.equal(JSON.parse(vuelta.hostPubkey).x, JSON.parse(ref.hostPubkey).x)

  for (const malo of ['', 'a.b.c', 'a.b.c.d.e', 'a.b.c.d e', 'a..c.d']) {
    assert.throws(() => decodeBroadcastRef(malo), (e) => e.code === 'bad-ref', `«${malo}»`)
  }
  assert.throws(() => encodeBroadcastRef({ key: 'k', secret: 's' }), (e) => e.code === 'bad-ref')
})

test('quien tiene el enlace ve el estado, sellado y firmado; el proxio no lee nada', async () => {
  const hub = new MockHub()
  const ana = await lobbyEn(hub, await bovedaDeMentira('Ana'))
  const beto = await lobbyEn(hub, await bovedaDeMentira('Beto'))

  const emision = await ana.lobby.openBroadcast()
  await emision.publish({ torneo: 'Torneo-secreto-4471', jugadores: ['Ana-9913', 'Luis-2207'] })

  const enlace = encodeBroadcastRef(emision.ref)
  const mira = await beto.lobby.watchBroadcast(decodeBroadcastRef(enlace))
  await hasta(() => mira.status === 'live' && mira.state)
  assert.equal(mira.state.torneo, 'Torneo-secreto-4471')

  const llegados = []
  mira.on('state', (s, meta) => llegados.push({ s, meta }))
  await emision.publish({ torneo: 'Torneo-secreto-4471', ronda: 2 })
  await hasta(() => llegados.length === 1)
  assert.equal(mira.state.ronda, 2)
  assert.ok(llegados[0].meta.at > 0)

  // Quien mira no se publica: en el canal solo está el emisor.
  assert.deepEqual(hub.members(emision.channel), [ana.ep.token])
  assert.equal(emision.viewers, 1)

  const visto = cable(hub)
  for (const secreto of ['Torneo-secreto-4471', 'Ana-9913', 'Luis-2207', emision.ref.secret, `"${K.BCAST}"`, `"${K.WATCH}"`]) {
    assert.equal(visto.includes(secreto), false, `el proxio no puede ver «${secreto}»`)
  }
  assert.equal(hub.plaintextNoHello.length, 0, 'fuera del saludo, nada va en claro')
})

test('sin el secreto del enlace no llega nada, y se dice', async () => {
  const hub = new MockHub()
  const ana = await lobbyEn(hub, await bovedaDeMentira('Ana'))
  const intruso = await lobbyEn(hub, await bovedaDeMentira('Intruso'))

  const emision = await ana.lobby.openBroadcast()
  await emision.publish({ torneo: 'privado' })

  // Tiene el canal y la llave del emisor (se pueden averiguar), pero no el secreto.
  const mira = await intruso.lobby.watchBroadcast({ ...emision.ref, secret: 'adivinado' })
  await hasta(() => mira.status === 'denied')
  assert.equal(mira.state, null)
  assert.equal(emision.viewers, 0)
  assert.equal(intruso.ep.received.some(r => r.env.k === K.BCAST), false, 'no le llegó ningún estado')
})

test('un estado que no firmó el emisor se descarta, aunque llegue sellado', async () => {
  const hub = new MockHub()
  const ana = await lobbyEn(hub, await bovedaDeMentira('Ana'))
  const beto = await lobbyEn(hub, await bovedaDeMentira('Beto'))
  const falsario = await lobbyEn(hub, await bovedaDeMentira('Falsario'))

  const emision = await ana.lobby.openBroadcast()
  await emision.publish({ ganador: 'Ana' })
  const mira = await beto.lobby.watchBroadcast(emision.ref)
  await hasta(() => mira.state)

  const eventos = []
  mira.on('event', (e) => eventos.push(e.event))
  // Cualquiera puede sellarle a Beto (su llave de cifrado es pública). Lo que no puede es
  // firmar como Ana.
  const payload = { v: 1, g: 'padel', k: emision.key, at: Date.now() + 60000, seq: 99, state: { ganador: 'Falsario' } }
  const { signature } = await falsario.identity.signData(payload)
  await falsario.ep.peerIdentity(beto.ep.token)
  await falsario.ep.sendSealedTo(beto.ep.token, envelope('padel', emision.key, K.BCAST, { payload, signature }))
  await hasta(() => eventos.includes('forged'))
  assert.equal(mira.state.ganador, 'Ana')

  // Y publicarse en el canal no le sirve para hacerse pasar por el emisor.
  await falsario.ep.publish(emision.channel)
  await tick()
  assert.equal(mira.state.ganador, 'Ana')
})

test('lo viejo o repetido no pisa lo nuevo', async () => {
  const hub = new MockHub()
  const ana = await lobbyEn(hub, await bovedaDeMentira('Ana'))
  const beto = await lobbyEn(hub, await bovedaDeMentira('Beto'))

  const emision = await ana.lobby.openBroadcast()
  await emision.publish({ ronda: 1 })
  const mira = await beto.lobby.watchBroadcast(emision.ref)
  await hasta(() => mira.state && mira.state.ronda === 1)
  const primero = hub.wire.find(f => f.from === ana.ep.token && f.to.includes(beto.ep.token) && f.payload && f.payload.sealed)
  await emision.publish({ ronda: 2 })
  await hasta(() => mira.state.ronda === 2)

  // Quien opera el proxio vuelve a entregar el sobre de la ronda 1: está bien sellado y
  // bien firmado, pero es viejo.
  hub.route(ana.ep.token, beto.ep.token, primero.payload)
  await tick()
  assert.equal(mira.state.ronda, 2)
})

test('el enlace sobrevive a que el emisor recargue: quien mira conserva lo último y vuelve a recibir', async () => {
  const hub = new MockHub()
  const idAna = await bovedaDeMentira('Ana')
  const ana = await lobbyEn(hub, idAna)
  const beto = await lobbyEn(hub, await bovedaDeMentira('Beto'))

  const emision = await ana.lobby.openBroadcast()
  await emision.publish({ ronda: 1 })
  const ref = emision.ref
  const mira = await beto.lobby.watchBroadcast(ref)
  await hasta(() => mira.state && mira.state.ronda === 1)

  // Se cae la página del emisor: otro token, sin nada en memoria.
  hub.disconnect(ana.ep.token)
  await hasta(() => mira.status === 'host-offline')
  assert.equal(mira.state.ronda, 1, 'lo último que llegó se conserva')

  // Vuelve con la misma identidad y la misma referencia (la app la guardó).
  const anaOtraVez = await lobbyEn(hub, idAna)
  const deNuevo = await anaOtraVez.lobby.openBroadcast({ ref: { key: ref.key, secret: ref.secret } })
  await deNuevo.publish({ ronda: 2 })
  await hasta(() => mira.status === 'live' && mira.state.ronda === 2)
})

test('quien mira y el emisor sobreviven a reconectar sin recargar', async () => {
  const hub = new MockHub()
  const ana = await lobbyEn(hub, await bovedaDeMentira('Ana'))
  const beto = await lobbyEn(hub, await bovedaDeMentira('Beto'))
  const emision = await ana.lobby.openBroadcast()
  await emision.publish({ ronda: 1 })
  const mira = await beto.lobby.watchBroadcast(emision.ref)
  await hasta(() => mira.state)

  beto.ep.reconnect('tk-beto-2')
  await emision.publish({ ronda: 2 })
  await hasta(() => mira.state.ronda === 2)

  ana.ep.reconnect('tk-ana-2')
  await emision.publish({ ronda: 3 })
  await hasta(() => mira.state.ronda === 3)
})

test('el emisor pone un tope a cuántos miran', async () => {
  const hub = new MockHub()
  const ana = await lobbyEn(hub, await bovedaDeMentira('Ana'))
  const beto = await lobbyEn(hub, await bovedaDeMentira('Beto'))
  const carla = await lobbyEn(hub, await bovedaDeMentira('Carla'))

  const emision = await ana.lobby.openBroadcast({ maxViewers: 1 })
  await emision.publish({ ronda: 1 })
  const uno = await beto.lobby.watchBroadcast(emision.ref)
  await hasta(() => uno.state)
  const dos = await carla.lobby.watchBroadcast(emision.ref)
  await hasta(() => dos.status === 'denied')
  assert.equal(emision.viewers, 1)
})

test('solo el emisor publica, y cerrar deja de emitir', async () => {
  const hub = new MockHub()
  const ana = await lobbyEn(hub, await bovedaDeMentira('Ana'))
  const beto = await lobbyEn(hub, await bovedaDeMentira('Beto'))
  const emision = await ana.lobby.openBroadcast()
  const mira = await beto.lobby.watchBroadcast(emision.ref)
  await assert.rejects(() => mira.publish({}), (e) => e.code === 'not-host')

  await emision.close()
  assert.deepEqual(hub.members(emision.channel), [])
  await assert.rejects(() => emision.publish({}), (e) => e.code === 'closed')
})
