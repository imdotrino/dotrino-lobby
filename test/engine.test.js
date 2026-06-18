import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngine } from '../src/engine.js'

const counter = {
  initialState: { scores: {}, target: 3 },
  reducer: (state, action, ctx) => {
    if (action && action.bad) throw new Error('bad-move')
    const scores = { ...state.scores }
    scores[ctx.seat] = (scores[ctx.seat] || 0) + (action.inc || 1)
    return { ...state, scores }
  },
  isOver: (state) => {
    for (const [seat, v] of Object.entries(state.scores)) if (v >= state.target) return { winner: seat, reason: 'reached' }
    return null
  }
}

test('engine aplica acciones y detecta fin', () => {
  const e = createEngine(counter)
  e.start(1)
  e.apply('p1', { inc: 1 }, {})
  assert.equal(e.getState().scores.p1, 1)
  assert.equal(e.checkOver(), null)
  e.apply('p1', { inc: 2 }, {})
  const over = e.checkOver()
  assert.deepEqual(over, { winner: 'p1', reason: 'reached' })
})

test('engine: reducer que lanza no muta el estado', () => {
  const e = createEngine(counter)
  e.start(1)
  e.apply('p1', { inc: 1 }, {})
  assert.throws(() => e.apply('p1', { bad: true }, {}), /bad-move/)
  assert.equal(e.getState().scores.p1, 1) // intacto
})

test('engine: view proyecta info oculta por asiento', () => {
  const cards = {
    initialState: { hands: { p1: ['A', 'B'], p2: ['C', 'D'] }, table: [] },
    reducer: (s) => s,
    view: (s, seat) => ({ table: s.table, myHand: seat ? s.hands[seat] : null, counts: { p1: s.hands.p1.length, p2: s.hands.p2.length } })
  }
  const e = createEngine(cards)
  e.start(1)
  const v1 = e.viewFor('p1'), v2 = e.viewFor('p2'), vs = e.viewFor(null)
  assert.deepEqual(v1.myHand, ['A', 'B'])
  assert.deepEqual(v2.myHand, ['C', 'D'])
  assert.equal(vs.myHand, null)             // espectador no ve manos
  assert.equal(v1.hands, undefined)          // no se filtra el estado completo
  assert.deepEqual(v1.counts, { p1: 2, p2: 2 })
})

test('engine: azar determinista por semilla', () => {
  const dealer = {
    initialState: (rng) => ({ roll: Math.floor(rng() * 1000) }),
    reducer: (s, a, ctx) => ({ roll: Math.floor(ctx.rng() * 1000) })
  }
  const e1 = createEngine(dealer); e1.start(42)
  const e2 = createEngine(dealer); e2.start(42)
  assert.equal(e1.getState().roll, e2.getState().roll)
  e1.apply('p1', {}, {}); e2.apply('p1', {}, {})
  assert.equal(e1.getState().roll, e2.getState().roll)
})

test('engine: viewFor sin view fn devuelve copia del estado', () => {
  const e = createEngine(counter); e.start(1)
  e.apply('p1', { inc: 1 }, {})
  const v = e.viewFor('p1')
  assert.deepEqual(v.scores, { p1: 1 })
  v.scores.p1 = 99
  assert.equal(e.getState().scores.p1, 1) // la vista es copia, no referencia
})
