# @dotrino/lobby

> **Parte del ecosistema [Dotrino](https://dotrino.com).** Dotrino es un ecosistema de aplicaciones centradas en la privacidad de los datos: tu información es tuya, y las decisiones sobre ella también — qué compartes, con quién, cuándo y por qué. Sin anuncios, sin cookies, sin rastreo de datos, sin vender tu identidad a nadie.

**Lobby + matchmaking reciclable para cualquier juego del ecosistema Dotrino.**

Resuelve, una sola vez y para todos los juegos, lo que el ajedrez, el chat y
compañía venían reimplementando a mano: **descubrir/crear/unir salas, asientos,
espectadores, autoridad de host (serverless), presencia, pausa/reconexión por
identidad, sincronización autoritativa con resync, verificación del oponente,
matchmaking filtrado por reputación y recibo de partida co-firmado.**

Está construido **sobre** los pilares compartidos — no reimplementa transporte ni
identidad:

- `@dotrino/proxy-client` **≥ 0.21.0** — transporte (canales, `identify`,
  **sellado extremo a extremo**, WebRTC). **Una sola conexión**, reutilizable.
- `@dotrino/identity` — vault (firma, challenge/response,
  **contactos**).
- `@dotrino/reputation` — web-of-trust (gate de admisión,
  ranking, atestaciones `txBound`). *Opcional.*

Headless y framework-agnóstico (vanilla + EventEmitter). Sirve igual para Vue,
vanilla o nativo-vía-WebView.

---

## Todo lo dirigido va SELLADO (desde 0.8.0)

El proxio **no cifra**: `send`/`sendByPubkey` mandan el payload tal cual y lo lee quien
opera el servidor — y el de producción corre en un VPS alquilado. Hasta 0.7.0 esta
librería hablaba así, o sea que **el chat, las jugadas, el nombre de la sala y el apodo
de cada jugador iban legibles**. CONVENCIONES §4.1 lo llama por su nombre: un agujero.

Desde 0.8.0:

- **de salida**, todo lo de la sala va sellado (`sendSealedTo` por token, `sendSealed`
  por pubkey para invitaciones y re-clave). No hay ninguna función que mande en claro;
- **de entrada**, lo que llega sin sellar **se tira**. Sellar solo de salida no sirve de
  nada: quien acepta texto en claro se salta el sellado entero, y alguien que nunca leyó
  nada podría colar una jugada falsa;
- **hace falta identidad**. `createLobby` sin bóveda lanza `code: 'no-identity'`: sellar
  es sellar *a alguien*, y antes esto degradaba a jugar en claro.

### La presentación, que es lo único que va sin sellar

Sellar exige la llave de cifrado del otro, y el pilar la averigua **por su publickey**.
Pero el proxio entrega por **token**, y un token no dice de quién es: del canal de
descubrimiento solo salen tokens. En una sala de desconocidos nadie sabe todavía a quién
le está hablando, así que alguien tiene que hablar primero — y el primero no puede sellar.

Esa primera frase es la **presentación**, y **no lleva nada del usuario: solo una
publickey**, que es justo el dato que el proxio ya tiene de los dos desde `identify`. Son
dos mensajes (`K.HI` al entrar, `K.INFO_REQUEST` al listar salas) y sus respuestas **ya
van selladas**. A partir de ahí, todo.

Si la app ya sabe quién es el host, ni eso: `joinRoom(roomId, { hostPubkey })` sella desde
el primer mensaje. La pubkey viene en el resumen de `listRooms` (`hostPubkey`) y en la
invitación (`from`); `quickMatch` la pasa sola.

> Cuando `@dotrino/proxy-client` aprenda a atar tokens a identidades por su cuenta
> (el saludo del transporte), esta presentación se borra y se usa la suya: es del
> transporte, no del lobby.

**Lo que esto NO resuelve, dicho en voz alta.** Quien presenta a dos desconocidos es el
proxio: del canal salen tokens, y la identidad del host la dice él mismo. Un proxio
hostil podría poner la suya en medio y leer la partida — eso no lo arregla ningún
sellado, lo arregla **conocer la pubkey del otro por fuera**: una invitación de un
contacto (`from`), un enlace que la lleve, o un acta compartida. Lo que sí queda cerrado
con esto es lo de siempre y lo que de verdad pasa: que el que opera el servidor **lea sin
más** el chat y las jugadas de todas las salas.

### Qué NO se sella

Los **canales públicos** (`publish`/`list`): son públicos por diseño (§4.1) y por ahí solo
va el nombre del canal y quién está en él. De paso, en 0.8.0 se quitó el
`{ roomName, gameType }` que se publicaba con el canal de descubrimiento: **el proxio se lo
quedaba y no se lo daba a nadie**, así que el nombre de la sala solo viajaba para él.

---

## Idea central

El **host es uno de los jugadores** (no hay servidor central: *tu info, en tu
máquina*). La librería separa dos cosas:

1. **Lobby/Room** — toda la fontanería de salas/asientos/presencia/sync.
2. **Motor de turnos** *(opcional)* — el juego aporta **funciones puras**
   (`initialState`, `reducer`, `view`, `isOver`) y la lib valida en el host,
   sincroniza y hace resync. El ajedrez queda casi trivial; las cartas funcionan
   gracias a `view` (estado oculto por asiento) y al azar determinista sembrado.

---

## Instalación

```bash
npm i @dotrino/lobby \
      @dotrino/proxy-client \
      @dotrino/identity \
      @dotrino/reputation
```

---

## Quick start

```js
import { createLobby } from '@dotrino/lobby'

// 1) Definí tu juego como funciones puras (ejemplo: "tres en raya")
const tictactoe = {
  initialState: { board: Array(9).fill(null), turn: 'x' },
  reducer (state, action, ctx) {            // ctx = { seat, seats, rng, now }
    const mark = ctx.seat === 'x' ? 'x' : 'o'
    if (state.turn !== mark) throw new Error('no-es-tu-turno')
    if (state.board[action.cell]) throw new Error('ocupada')
    const board = state.board.slice()
    board[action.cell] = mark
    return { board, turn: mark === 'x' ? 'o' : 'x' }
  },
  isOver (state) {
    const L = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]
    for (const [a,b,c] of L) {
      const v = state.board[a]
      if (v && v === state.board[b] && v === state.board[c]) return { winner: v, reason: 'line' }
    }
    if (state.board.every(Boolean)) return { winner: null, reason: 'draw' }
    return null
  }
}

// 2) Creá el lobby (conecta e identifica con el vault solo)
const lobby = await createLobby({
  gameId: 'tictactoe',
  seats: ['x', 'o'],
  engine: tictactoe,
  start: 'ready',                 // arranca cuando ambos asientos están "listos"
  onSeatVacated: 'pause',         // si alguien se va: pausa + reconexión por pubkey
  matchmaking: { minReputation: 0.15, preferContacts: true }
})

// 3) Partida rápida
const room = await lobby.quickMatch({ autoSeat: true })

room.on('update', s => render(s))                 // s.seats, s.status, s.spectators
room.on('state',  game => renderBoard(game.board))// vista del juego para MI asiento
room.on('ended',  r => alert(`Ganó ${r.winner}`))

// 4) Jugar
boardEl.onclick = cell => room.action({ cell })
```

Crear/listar/unir manualmente:

```js
const room  = await lobby.createRoom({ name: 'Mi sala' })   // sos host
const rooms = await lobby.listRooms()                       // [{ roomId, name, openSeats, hostScore, isContact, ... }]
const room2 = await lobby.joinRoom(rooms[0].roomId)         // sos guest
```

---

## Asientos, espectadores y ciclo de vida

```js
room.takeSeat('x')     // tomar un asiento LIBRE (sin id → el primero libre)
room.setReady(true)    // start:'ready' arranca cuando todos los ocupados están listos
room.leaveSeat()       // volver a espectador
room.spectate()        // mirar sin jugar (recibe el estado, no puede actuar)
room.mySeat            // 'x' | 'o' | null
```

- **Sólo se toman asientos libres.** Para cambiar, el ocupante deja el suyo primero.
- **Espectadores**: reciben todos los `state`/`event`; sus `action()` se rechazan.
  Un espectador puede `takeSeat()` si hay un asiento libre (así "otro toma el
  lugar"). Con `onSeatVacated:'fill'`, la cola de espectadores rellena automático.
- **Estados**: `waiting → playing → ended`, con `paused` intermedio.

### ¿Qué pasa si un jugador se va / se cae?

Configurable con `onSeatVacated` (y el asiento va por **pubkey del vault**, no por
token efímero):

| Política | Comportamiento |
|---|---|
| `'pause'` *(default)* | La partida se pausa; el mismo jugador **recupera su asiento** al reconectar (dentro de `disconnectGraceMs`). Si vence el grace, el asiento se libera. |
| `'forfeit'` | Irse/caerse termina la partida a favor del resto (ranked). |
| `'fill'` | El asiento se libera y el primer espectador en cola lo toma; la partida sigue (drop-in/drop-out). |

---

## Motor de turnos (autoritativo)

El host instancia el motor; los guests sólo reflejan la **vista** que reciben.

```js
const engine = {
  initialState,                 // valor | (rng) => estado   (rng determinista, sembrado)
  reducer (state, action, ctx), // ctx = { seat, seats, rng, now }; throw Error(reason) para rechazar
  view (state, seat),           // opcional: proyección por asiento (info oculta). Default: estado completo
  isOver (state)                // opcional: { winner, reason } | null
}
```

- **Cartas / info oculta**: usá `view(state, seat)` para devolver sólo lo que ese
  asiento puede ver (su mano). Los espectadores reciben `view(state, null)`.
- **Azar (barajar, dados)**: usá `ctx.rng()` (y el `rng` de `initialState`). Es
  determinista por semilla → reproducible y registrable en el recibo.
- **Sin motor**: si no pasás `engine`, la sala funciona en **modo relay**:
  `room.send(data)` / `room.on('message')` y el juego sincroniza su propio estado.

---

## Reputación + contactos

Atraviesa todo el flujo (inyectá `reputation` para activarlo):

```js
// Gate de admisión (bidireccional): el host rechaza joiners y el lobby filtra salas.
matchmaking: { requireVouched: true, minReputation: 0.2, preferContacts: true }

// Invitar a un contacto (cola offline 24 h):
lobby.inviteContact(pubkey, { roomId: room.roomId, name: 'Revancha?' })
lobby.on('invite', inv => console.log('te invitaron a', inv.roomId))

// Verificación anti-impersonación: al sentarse se hace challenge/response.
// (requireVerify: true por defecto)

// Post-partida: calificar y agregar a contactos, con recibo co-firmado → txBound.
await room.ratePlayer(oppPubkey, { confianza: 5, afinidad: 3 }, { notes: 'gg' })
```

### Recibo de partida co-firmado

Al terminar, el host y cada co-jugador **co-firman** un recibo
`{ a, b, ts, sigA, sigB }` (cada uno firma `{op:'receipt',a,b,ts}` con su vault).
`ratePlayer` lo adjunta automáticamente, produciendo una atestación **`txBound`**:
prueba verificable de que *esos dos realmente jugaron juntos* (anti-sybil).

```js
room.on('receipt', ({ pubkey, receipt }) => { /* guardado para el rating */ })
room.matchReceipt(pubkey) // { a, b, ts, sigA, sigB } | null
```

---

## Eventos de `Room`

| Evento | Payload | Cuándo |
|---|---|---|
| `update` | `RoomState` | cambió asientos/estado/espectadores |
| `state` | `game` | cambió la vista de juego para mi asiento |
| `started` | `{ ts }` | arrancó la partida |
| `ended` | `{ winner, reason }` | terminó |
| `event` | `{ event, data }` | evento lateral genérico |
| `chat` | `{ from, name, text, ts }` | mensaje de chat |
| `message` | `data` | relay opaco (modo sin motor) |
| `rejected` | `{ reason }` | tu acción fue rechazada |
| `kicked` | `{ reason }` | el host te expulsó (verify/reputación) |
| `closed` | `{ reason }` | el host cerró / se perdió |
| `receipt` | `{ pubkey, receipt }` | recibo co-firmado listo |
| `left` | — | saliste de la sala (`room.leave()`) |

---

## API

```ts
createLobby(opts): Promise<Lobby>

Lobby.createRoom(opts?): Promise<Room>
Lobby.joinRoom(roomId, opts?): Promise<Room>   // opts.hostPubkey → sella desde el 1er mensaje
Lobby.listRooms(opts?): Promise<RoomSummary[]>
Lobby.quickMatch(opts?): Promise<Room>
Lobby.inviteContact(pubkey, { roomId, name }): Promise<void>   // sellada
Lobby.listContacts(): Promise<PeerInfo[]>
Lobby.reputationOf(pubkey): Promise<AggregateResult>

Room.takeSeat(seat?) / leaveSeat() / setReady(b) / spectate()
Room.action(a) / chat(text) / send(data) / start()
Room.ratePlayer(pubkey, indicators, opts?) / matchReceipt(pubkey)
Room.mySeat / status / seats / spectators / game / result / state
Room.leave()
```

Ver tipos completos en [`src/index.d.ts`](./src/index.d.ts).

---

## Notas de diseño / límites de v1

- `roomId === token del host` (modelo probado por el ajedrez). Si el host
  **reconecta**, su token cambia → la sala se considera nueva y los guests caen
  (`onHostLost: 'end'`). La **migración de host** (elección determinista del
  jugador de menor pubkey) está prevista como `onHostLost: 'migrate'` y queda como
  extensión futura.
- El recibo co-firmado se genera para los pares **host ↔ cada jugador** (cubre 1v1
  completo, p.ej. ajedrez). Recibos entre guests en mesas de N>2 quedan pendientes.
- Sincronización por **snapshot completo personalizado** por cambio (simple y
  correcto para juegos por turnos). Deltas/patches son una optimización futura.

## Tests

```bash
npm test          # node --test: todo
npm run test:cable   # solo la prueba de punta a punta por un socket de verdad
```

`test/sealed.test.js` mira **lo que ve quien opera el proxio** (el hub de pruebas sella
de verdad, con la cripto de `@dotrino/identity`) y `test/e2e-proxio.test.js` juega una
partida entera entre dos clientes de Node **por un WebSocket real**, contra un proxio que
apunta cada trama en los dos sentidos: ahí se comprueba que por el cable no pasan ni el
chat, ni las jugadas, ni los nombres.
