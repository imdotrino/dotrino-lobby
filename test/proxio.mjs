// UN PROXIO DE VERDAD, PERO QUE APUNTA TODO.
//
// Es un servidor WebSocket con el protocolo que usa `@dotrino/proxy-client`
// (connected/identify/encpub/enc-lookup/mensajes por token y por pubkey/canales), y su
// único añadido es que **guarda cada trama que pasa por él, en los dos sentidos**. Es
// decir: es exactamente la vista de quien opera el proxio de producción.
//
// No es un mock del sellado —del sellado no sabe nada, como el de verdad—: se limita a
// enrutar lo que le dan. Si algo se puede leer aquí, se puede leer en el VPS.

import { WebSocketServer } from 'ws'

export async function startProxio () {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((res) => wss.once('listening', res))
  const port = wss.address().port

  const conns = new Map()      // token → ws
  const pubkeys = new Map()    // publickey → token
  const encpubs = new Map()    // publickey → statement firmado
  const channels = new Map()   // canal → Set<token>
  const watchers = new Map()   // canal → Set<token>
  /** TODO lo que pasa por aquí: { dir:'in'|'out', token, frame } */
  const frames = []
  let n = 0

  const send = (token, frame) => {
    const ws = conns.get(token)
    frames.push({ dir: 'out', token, frame })
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(frame))
  }
  const reply = (token, frame, msg) => send(token, msg && msg.id ? { ...frame, id: msg.id } : frame)
  const members = (ch) => [...(channels.get(ch) || [])]
  const notify = (ch, frame, except) => {
    for (const t of [...(channels.get(ch) || []), ...(watchers.get(ch) || [])]) {
      if (t !== except) send(t, frame)
    }
  }

  wss.on('connection', (ws) => {
    const token = 'i' + (++n)
    conns.set(token, ws)
    send(token, {
      type: 'connected',
      instance: token,
      token,
      node: null,
      peers: [],
      protocol: 2,
      caps: ['channels', 'pubkey-routing', 'offline-queue', 'encpub']
    })

    ws.on('message', (raw) => {
      let m
      try { m = JSON.parse(raw.toString()) } catch (_) { return }
      frames.push({ dir: 'in', token, frame: m })

      // Mensaje dirigido por token (no lleva `type`: es la forma del pilar).
      if (Array.isArray(m.to) && typeof m.message === 'string') {
        for (const to of m.to) send(to, { type: 'message', from: token, message: m.message, timestamp: Date.now() })
        return
      }
      // Mensaje dirigido por pubkey.
      if (m.to_publickey && typeof m.message === 'string') {
        const list = Array.isArray(m.to_publickey) ? m.to_publickey : [m.to_publickey]
        for (const pk of list) {
          const to = pubkeys.get(pk)
          if (to) send(to, { type: 'message', from: token, message: m.message, timestamp: Date.now() })
        }
        return
      }

      switch (m.type) {
        case 'ping': return reply(token, { type: 'pong' }, m)
        case 'identify': {
          const pk = m.data && m.data.publickey
          if (pk) pubkeys.set(pk, token)
          return reply(token, { type: 'identified', publickey: pk }, m)
        }
        case 'encpub': {
          // El proxio es un BUZÓN: se queda el anuncio firmado y lo reparte tal cual.
          // No lo verifica ni le hace falta: quien pregunta comprueba la firma.
          const pk = m.data && m.data.publickey
          if (pk) encpubs.set(pk, { data: m.data, signature: m.signature })
          return reply(token, { type: 'encpub-announced', publickey: pk, stored: true }, m)
        }
        case 'enc-lookup': {
          const keys = []
          const missing = []
          for (const pk of m.publickeys || []) {
            const st = encpubs.get(pk)
            if (st) keys.push(st); else missing.push(pk)
          }
          return reply(token, { type: 'enc-lookup', keys, missing }, m)
        }
        case 'publish': {
          const ch = m.channel && m.channel.data && m.channel.data.name
          if (!channels.has(ch)) channels.set(ch, new Set())
          channels.get(ch).add(token)
          notify(ch, { type: 'joined', channel: ch, token }, token)
          return reply(token, { type: 'published', channel: ch }, m)
        }
        case 'unpublish': {
          const ch = m.channel && m.channel.data && m.channel.data.name
          if (channels.has(ch)) channels.get(ch).delete(token)
          notify(ch, { type: 'left', channel: ch, token }, token)
          return reply(token, { type: 'unpublished', channel: ch }, m)
        }
        case 'list': {
          const ch = m.channel && m.channel.data && m.channel.data.name
          return reply(token, { type: 'channel_list', channel: ch, tokens: members(ch), count: members(ch).length }, m)
        }
        case 'watch': {
          const ch = m.channel && m.channel.data && m.channel.data.name
          if (!watchers.has(ch)) watchers.set(ch, new Set())
          watchers.get(ch).add(token)
          return reply(token, { type: 'watched', channel: ch, tokens: members(ch) }, m)
        }
        case 'unwatch': {
          const ch = m.channel && m.channel.data && m.channel.data.name
          if (watchers.has(ch)) watchers.get(ch).delete(token)
          return reply(token, { type: 'unwatched', channel: ch }, m)
        }
        case 'channel_count':
          return reply(token, { type: 'channel_count', channel: m.channel, count: members(m.channel).length }, m)
        case 'list_channels':
          return reply(token, { type: 'channels_list', channels: [...channels.keys()] }, m)
        default:
          return reply(token, { type: 'error', error: `unknown frame: ${m.type}` }, m)
      }
    })

    ws.on('close', () => {
      conns.delete(token)
      for (const [ch, set] of channels) {
        if (!set.delete(token)) continue
        notify(ch, { type: 'disconnected', token, channel: ch }, token)
      }
    })
  })

  return {
    url: `ws://127.0.0.1:${port}`,
    port,
    frames,
    /** Todo lo que pasó por el cable, como texto: es lo que el proxio puede leer. */
    text: () => frames.map(f => JSON.stringify(f.frame)).join('\n'),
    /** Los mensajes dirigidos, ya desempaquetados (el payload va como string JSON). */
    directed: () => frames
      .filter(f => (f.dir === 'in' && (Array.isArray(f.frame.to) || f.frame.to_publickey)) || (f.dir === 'out' && f.frame.type === 'message'))
      .map(f => { try { return JSON.parse(f.frame.message) } catch (_) { return f.frame.message } }),
    stop: () => new Promise((res) => { for (const ws of conns.values()) { try { ws.close() } catch (_) {} } wss.close(() => res()) })
  }
}
