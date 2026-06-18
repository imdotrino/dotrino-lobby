// Motor de turnos autoritativo (lado host).
//
// El juego aporta funciones puras y el motor se encarga de: mantener el estado
// autoritativo, validar/aplicar acciones, proyectar vistas por asiento (para
// info oculta como la mano de cartas), azar determinista sembrado y detección
// de fin de partida. Sólo se instancia en el host; los guests sólo guardan la
// vista que reciben.
//
// spec = {
//   initialState: value | (rng) => state,
//   reducer: (state, action, ctx) => newState   // ctx = { seat, seats, rng, now }; throw para rechazar
//   view?:   (state, seat) => stateVisibleParaEseAsiento   // default: estado completo
//   isOver?: (state) => ({ winner, reason }) | falsy
// }

import { mulberry32, hashSeed, clone, clock } from './util.js'

export function createEngine (spec = {}) {
  if (typeof spec.reducer !== 'function') {
    throw new Error('[lobby] engine: spec.reducer es obligatorio')
  }
  const viewFn = typeof spec.view === 'function' ? spec.view : null
  const isOverFn = typeof spec.isOver === 'function' ? spec.isOver : () => null

  let state = null
  let rng = null
  let seed = null
  let started = false

  function makeInitial () {
    const init = spec.initialState
    if (typeof init === 'function') return init(rng)
    if (init === undefined) return {}
    return clone(init)
  }

  return {
    /** ¿Ya arrancó la partida? */
    get started () { return started },
    /** Semilla usada (para recibos / reproducibilidad). */
    get seed () { return seed },

    /**
     * Arranca (o reinicia) la partida con una semilla determinista.
     * @param {number|string} [seedValue] si se omite, se deriva del reloj.
     */
    start (seedValue) {
      seed = seedValue == null ? (clock.now() >>> 0) : seedValue
      rng = mulberry32(typeof seed === 'number' ? seed : hashSeed(seed))
      state = makeInitial()
      started = true
      return state
    },

    /**
     * Aplica una acción de un asiento. Lanza Error(reason) si el reducer rechaza.
     * @param {string} seat  id del asiento que actúa
     * @param {any} action
     * @param {object} seatsSnapshot  ocupación de asientos para contexto del reducer
     * @returns {any} el nuevo estado autoritativo
     */
    apply (seat, action, seatsSnapshot) {
      if (!started) throw new Error('game-not-started')
      const ctx = { seat, seats: seatsSnapshot || {}, rng: rng || Math.random, now: clock.now() }
      const next = spec.reducer(state, action, ctx)
      if (next === undefined) throw new Error('reducer-returned-undefined')
      state = next
      return state
    },

    /** Estado autoritativo completo (host). */
    getState () { return state },

    /** Carga un estado completo (resync/persistencia). */
    load (s) { state = s; started = true },

    /** Proyección visible para un asiento (o null = espectador / vista pública).
     *  Una view() del juego que lanza no debe tumbar la difusión: degradamos a
     *  vista nula (segura respecto a info oculta) y logueamos. */
    viewFor (seat) {
      if (state == null) return null
      if (!viewFn) return clone(state)
      try { return viewFn(state, seat) }
      catch (e) { console.warn('[lobby] view() lanzó para el asiento', seat, e); return null }
    },

    /** ¿Terminó? → { winner, reason } | null */
    checkOver () {
      if (state == null) return null
      const r = isOverFn(state)
      return r || null
    },

    reset () { state = null; rng = null; seed = null; started = false }
  }
}
