// Tipos de @dotrino/lobby

export type Role = 'host' | 'guest'
export type RoomStatus = 'waiting' | 'playing' | 'paused' | 'ended'
export type SeatStatus = 'open' | 'occupied' | 'disconnected'
export type StartMode = 'ready' | 'full' | 'manual'
export type VacancyPolicy = 'pause' | 'forfeit' | 'fill'
export type HostLostPolicy = 'end' | 'migrate'

export const STATUS: { WAITING: 'waiting'; PLAYING: 'playing'; PAUSED: 'paused'; ENDED: 'ended' }
export const SEAT: { OPEN: 'open'; OCCUPIED: 'occupied'; DISCONNECTED: 'disconnected' }

/** Spec del motor de turnos autoritativo. El juego aporta funciones puras. */
export interface EngineSpec<S = any, A = any> {
  /** Estado inicial (valor) o factoría que recibe el rng sembrado. */
  initialState: S | ((rng: () => number) => S)
  /** Aplica una acción. ctx = { seat, seats, rng, now }. Lanza Error(reason) para rechazar. */
  reducer: (state: S, action: A, ctx: ReducerCtx) => S
  /** Proyección visible para un asiento (o null = espectador). Default: estado completo. */
  view?: (state: S, seat: string | null) => any
  /** ¿Terminó? → { winner, reason } | falsy. */
  isOver?: (state: S) => { winner: string | null; reason?: string } | null | undefined | false
}

export interface ReducerCtx {
  seat: string
  seats: Record<string, { pubkey: string | null; name: string | null; status: SeatStatus; occupied: boolean }>
  rng: () => number
  now: number
}

export interface SeatView {
  id: string
  pubkey: string | null
  name: string | null
  ready: boolean
  status: SeatStatus
  occupied: boolean
}

export interface SpectatorView { pubkey: string | null; name: string | null }

export interface RoomState {
  roomId: string
  gameId: string
  name: string | null
  hostPubkey: string | null
  status: RoomStatus
  seats: Record<string, SeatView>
  spectators: SpectatorView[]
  result: { winner: string | null; reason?: string } | null
  game: any
  version: number
}

export interface RoomSummary {
  roomId: string
  gameId: string
  name: string | null
  hostPubkey: string | null
  status: RoomStatus
  players: number
  openSeats: number
  max: number
  spectators: number
  seats: Array<{ id: string; status: SeatStatus; name: string | null }>
  /** Añadidos por listRooms (enrich): reputación ponderada y flag de contacto. */
  reputation?: any
  hostScore?: number
  isContact?: boolean
}

export interface Receipt { a: string; b: string; ts: number; sigA: string; sigB: string }

export interface MatchmakingConfig {
  /** Sólo emparejar con avalados por tu red (trustedCount > 0). */
  requireVouched?: boolean
  /** Score mínimo 0..1 para admitir/emparejar. */
  minReputation?: number
  /** Priorizar salas de contactos al ordenar. Default true. */
  preferContacts?: boolean
}

export interface CreateLobbyOptions {
  /** Namespace del juego (canales). Obligatorio. */
  gameId: string
  /** Asientos: ['white','black'] o { min, max }. */
  seats?: string[] | { min?: number; max?: number }
  /** Motor de turnos opcional. Sin él, la sala funciona en modo relay. */
  engine?: EngineSpec
  /** Instancia de Identity ya conectada (si no, se conecta sola). */
  identity?: any
  /** Instancia de createVaultReputation (opcional). */
  reputation?: any
  /** Cliente proxy ya creado (reuso de conexión). */
  proxy?: any
  /** Transporte ya creado (avanzado / tests). */
  transport?: Transport
  /** URL del proxy. */
  url?: string
  start?: StartMode
  onSeatVacated?: VacancyPolicy
  onHostLost?: HostLostPolicy
  allowSpectators?: boolean
  maxSpectators?: number
  /** Grace period (ms) para reclamar asiento tras caída. Default 45000. */
  disconnectGraceMs?: number
  /** Exigir challenge/response antes de sentar (anti-impersonación). Default true. */
  requireVerify?: boolean
  matchmaking?: MatchmakingConfig
  /** Nombre a mostrar del jugador. */
  playerName?: string
  /** Semilla del motor (si se omite, la elige el host). */
  seed?: number | string
}

export interface CreateRoomOptions { name?: string; playerName?: string; seed?: number | string }
export interface JoinRoomOptions { playerName?: string }
export interface QuickMatchOptions extends CreateRoomOptions, JoinRoomOptions {
  /** Ventana (ms) para descubrir salas. */
  timeout?: number
  /** Asiento a tomar automáticamente. */
  seat?: string
  /** Auto-sentarse al unir/crear. Default true. */
  autoSeat?: boolean
}

/** Emisor de eventos mínimo. */
export declare class Emitter {
  on (event: string, handler: (...args: any[]) => void): () => void
  once (event: string, handler: (...args: any[]) => void): () => void
  off (event: string, handler: (...args: any[]) => void): void
  emit (event: string, ...args: any[]): void
  removeAllListeners (): void
}

/**
 * Una sala. Eventos: 'update'(RoomState), 'state'(game), 'event'({event,data}),
 * 'message'(relay), 'chat', 'started', 'ended'(result), 'closed', 'kicked',
 * 'rejected', 'receipt'({pubkey,receipt}), 'left'.
 */
export declare class Room extends Emitter {
  readonly role: Role
  readonly isHost: boolean
  readonly roomId: string
  readonly gameId: string
  readonly status: RoomStatus
  readonly result: { winner: string | null; reason?: string } | null
  readonly seats: Record<string, SeatView>
  readonly spectators: SpectatorView[]
  readonly game: any
  readonly version: number
  readonly state: RoomState
  readonly mySeat: string | null

  takeSeat (seatId?: string): boolean
  leaveSeat (): void
  setReady (ready?: boolean): void
  spectate (): void
  action (action: any): void
  chat (text: string): void
  send (data: any): void
  /** Host-only: arrancar/reiniciar manualmente. */
  start (): boolean
  /** Califica a un co-jugador (contacto + atestación, con recibo si existe). */
  ratePlayer (pubkey: string, valueOrIndicators: number | Record<string, number>, opts?: { notes?: string; nickname?: string; addContact?: boolean; receipt?: Receipt }): Promise<{ ok: true; txBound: boolean }>
  /** Recibo co-firmado con `pubkey` (o null). */
  matchReceipt (pubkey: string): Receipt | null
  leave (): Promise<void>
}

/**
 * Lobby. Eventos: 'invite'({from, roomId, name, fromName}) cuando un contacto te
 * invita; 'rooms-changed'({type:'joined'|'left', token}) cuando cambia el canal
 * de descubrimiento (llamá listRooms para el detalle actualizado).
 */
export declare class Lobby extends Emitter {
  readonly gameId: string
  readonly rooms: Room[]
  createRoom (opts?: CreateRoomOptions): Promise<Room>
  joinRoom (roomId: string, opts?: JoinRoomOptions): Promise<Room>
  listRooms (opts?: { timeout?: number; enrich?: boolean }): Promise<RoomSummary[]>
  quickMatch (opts?: QuickMatchOptions): Promise<Room>
  inviteContact (pubkey: string, opts?: { roomId?: string; name?: string }): void
  listContacts (): Promise<any[]>
  reputationOf (pubkey: string): Promise<any>
  destroy (): Promise<void>
}

export declare class Transport {
  constructor (opts?: { proxy?: any; identity?: any; url?: string })
  readonly token: string | null
  readonly isReady: boolean
  connect (): Promise<string | null>
  subscribe (gameId: string, fn: (from: string, env: any, meta: any) => void): () => void
  send (to: string | string[], env: any): void
  sendByPubkey (pubkeys: string | string[], env: any): void
}

export function createLobby (opts: CreateLobbyOptions): Promise<Lobby>

export interface Engine {
  readonly started: boolean
  readonly seed: number | string | null
  start (seed?: number | string): any
  apply (seat: string, action: any, seatsSnapshot?: any): any
  getState (): any
  load (state: any): void
  viewFor (seat: string | null): any
  checkOver (): { winner: string | null; reason?: string } | null
  reset (): void
}
export function createEngine (spec: EngineSpec): Engine

// Helpers de reputación / contactos
export function createRepGate (reputation: any, gate?: MatchmakingConfig): (pubkey: string) => Promise<{ ok: boolean; reason?: string; rep?: any }>
export function rankRooms (rooms: RoomSummary[], ctx?: { reputation?: any; contacts?: Set<string>; preferContacts?: boolean }): Promise<RoomSummary[]>
export function ratePlayer (identity: any, reputation: any, pubkey: string, valueOrIndicators: number | Record<string, number>, opts?: any): Promise<{ ok: true; txBound: boolean }>
export function receiptPayload (a: string, b: string, ts: number): { op: 'receipt'; a: string; b: string; ts: number }
export function signReceiptHalf (identity: any, a: string, b: string, ts: number): Promise<string>

// Protocolo / utilidades
export const K: Record<string, string>
export function discoveryChannel (gameId: string): string
export function roomChannel (gameId: string, roomId: string): string
export function envelope (gameId: string, roomId: string, kind: string, data?: any, seq?: number): any
export function parseEnvelope (payload: any): { g: string; r: string; k: string; d: any; s: number | null } | null
export function mulberry32 (seed: number): () => number
export function hashSeed (str: string): number
export function shuffle<T> (array: T[], rng: () => number): T[]
export function normalizeSeats (spec: string[] | { min?: number; max?: number }): { ids: string[]; min: number; max: number; named: boolean }
export function samePubkey (a: string, b: string): boolean
