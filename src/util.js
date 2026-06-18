// Utilidades internas de @dotrino/lobby.
// Sin dependencias: EventEmitter mínimo, RNG determinista sembrado,
// normalización de asientos y helpers varios.

/**
 * EventEmitter mínimo (navegador + node). on() devuelve un desuscriptor.
 * Los errores en un handler no rompen al resto de handlers.
 */
export class Emitter {
  constructor () { this._h = new Map() }

  on (event, handler) {
    if (typeof handler !== 'function') return () => {}
    let set = this._h.get(event)
    if (!set) { set = new Set(); this._h.set(event, set) }
    set.add(handler)
    return () => this.off(event, handler)
  }

  once (event, handler) {
    const off = this.on(event, (...args) => { off(); handler(...args) })
    return off
  }

  off (event, handler) {
    const set = this._h.get(event)
    if (set) set.delete(handler)
  }

  emit (event, ...args) {
    const set = this._h.get(event)
    if (!set) return
    for (const h of [...set]) {
      try { h(...args) } catch (e) { console.error(`[lobby] handler error on "${event}":`, e) }
    }
  }

  removeAllListeners () { this._h.clear() }
}

/** Reloj inyectable (los tests pueden sustituirlo). */
export const clock = { now: () => Date.now() }

/**
 * PRNG determinista (mulberry32). Devuelve floats en [0,1).
 * Misma semilla ⇒ misma secuencia, en cualquier máquina. Esto permite que el
 * host genere azar (barajar/dados) de forma reproducible y verificable.
 * @param {number} seed entero de 32 bits
 */
export function mulberry32 (seed) {
  let a = seed >>> 0
  return function rng () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Hash de string → entero de 32 bits (FNV-1a). Para derivar semillas de seeds string. */
export function hashSeed (str) {
  let h = 0x811c9dc5
  const s = String(str)
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Baraja Fisher–Yates in-place usando un rng() dado (no muta el original si se pasa copia). */
export function shuffle (array, rng) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = array[i]; array[i] = array[j]; array[j] = tmp
  }
  return array
}

/** Clon profundo (structuredClone si existe; si no, JSON). */
export function clone (value) {
  if (value == null) return value
  try {
    if (typeof structuredClone === 'function') return structuredClone(value)
  } catch (_) { /* fall through */ }
  return JSON.parse(JSON.stringify(value))
}

/**
 * Normaliza la especificación de asientos a una forma canónica.
 *  - Array de ids  → asientos nombrados (p.ej. ['white','black']).
 *  - { min, max }  → genera ids 's1'..'sN'.
 * @returns {{ ids: string[], min: number, max: number, named: boolean }}
 */
export function normalizeSeats (spec) {
  if (Array.isArray(spec)) {
    if (!spec.length) throw new Error('[lobby] seats: el array de asientos no puede estar vacío')
    const ids = spec.map(String)
    return { ids, min: ids.length, max: ids.length, named: true }
  }
  const max = Math.max(1, (spec && (spec.max ?? spec.min)) || 2)
  const min = Math.max(1, Math.min(max, (spec && spec.min) || max))
  const ids = Array.from({ length: max }, (_, i) => 's' + (i + 1))
  return { ids, min, max, named: false }
}

/** Igualdad de pubkeys tolerante a diferencias de formato JWK (orden de claves). */
export function samePubkey (a, b) {
  if (!a || !b) return false
  if (a === b) return true
  try {
    const pa = typeof a === 'string' ? JSON.parse(a) : a
    const pb = typeof b === 'string' ? JSON.parse(b) : b
    return pa && pb && pa.x === pb.x && pa.y === pb.y && pa.crv === pb.crv
  } catch (_) { return false }
}

/** Promesa que resuelve tras `ms`. */
export function delay (ms) { return new Promise(r => setTimeout(r, ms)) }

/** Id corto aleatorio (no criptográfico) para correlación de mensajes. */
export function shortId () {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().slice(0, 8)
  } catch (_) {}
  return Math.floor(Math.random() * 0xffffffff).toString(36)
}
