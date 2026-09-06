// Integración reputación + contactos para el lobby.
//
// Reusa @dotrino/reputation (createVaultReputation) y los
// contactos del vault (@dotrino/identity), inyectados por
// duck-typing. Tres usos:
//   1. Gate de admisión (filtrar salas / rechazar joiners por reputación).
//   2. Ranking de salas (priorizar contactos / mejor reputación).
//   3. Recibo de partida co-firmado → atestación txBound ("jugamos juntos").

import { samePubkey } from './util.js'

/**
 * Crea una función de admisión `gate(pubkey) → { ok, reason?, rep? }`.
 * Best-effort: si el servicio de reputación falla, NO bloquea (devuelve ok).
 * @param {object|null} reputation  instancia de createVaultReputation
 * @param {object} [gate]
 * @param {boolean} [gate.requireVouched] exigir aval de la red (trustedCount>0)
 * @param {number}  [gate.minReputation]  score mínimo 0..1
 */
export function createRepGate (reputation, gate = {}) {
  const minRep = typeof gate.minReputation === 'number' ? gate.minReputation : null
  const requireVouched = !!gate.requireVouched
  const active = !!reputation && (minRep != null || requireVouched)
  return async function passes (pubkey) {
    if (!active || !pubkey) return { ok: true }
    try {
      const r = await reputation.reputationOf(pubkey)
      if (requireVouched && !(r && r.trustedCount > 0)) return { ok: false, reason: 'not-vouched', rep: r }
      if (minRep != null) {
        const score = r && r.score != null ? r.score : 0
        if (score < minRep) return { ok: false, reason: 'low-reputation', rep: r }
      }
      return { ok: true, rep: r }
    } catch (_) {
      return { ok: true } // no romper el matchmaking si reputation.dotrino.com no responde
    }
  }
}

/**
 * Enriquma resúmenes de sala con reputación y flag de contacto, y los ordena:
 * primero salas con contactos, luego por score descendente.
 * @param {Array} rooms  [{ hostPubkey, ... }]
 * @param {object} ctx { reputation, contacts: Set<pubkey>, preferContacts }
 */
export async function rankRooms (rooms, { reputation, contacts, preferContacts = true } = {}) {
  const enriched = await Promise.all(rooms.map(async (room) => {
    let rep = null
    if (reputation && room.hostPubkey) {
      try { rep = await reputation.reputationOf(room.hostPubkey) } catch (_) {}
    }
    const isContact = !!(contacts && room.hostPubkey && [...contacts].some(c => samePubkey(c, room.hostPubkey)))
    return { ...room, reputation: rep, hostScore: rep && rep.score != null ? rep.score : 0, isContact }
  }))
  // El desempate por roomId NO es cosmético: sin él, dos salas con el mismo
  // score quedan en el orden en que contestaron al INFO (una carrera de red que
  // sale distinta cada vez), así que la lista pública bailaba en cada refresco.
  enriched.sort((a, b) => {
    if (preferContacts && a.isContact !== b.isContact) return a.isContact ? -1 : 1
    if (b.hostScore !== a.hostScore) return b.hostScore - a.hostScore
    return String(a.roomId || '').localeCompare(String(b.roomId || ''))
  })
  return enriched
}

// ── Recibo de partida co-firmado ────────────────────────────────────

/** Payload canónico que ambos jugadores firman (debe coincidir con el server). */
export function receiptPayload (a, b, ts) { return { op: 'receipt', a, b, ts } }

/**
 * Firma MI mitad, y devuelve el paquete entero: `{ sig, signer, chain }`.
 *
 * Antes devolvía solo la firma, y con eso el registro no puede comprobar nada: firma el
 * APARATO y el recibo (o el evento) es entre dos PERSONAS, así que hace falta la cadena que
 * dice que ese aparato habla por esa identidad. Sin ella, una partida jugada desde el
 * teléfono no contaba — daba «recibo inválido» o «co-firma inválida».
 */
async function firmarMitad (identity, payload) {
  const signed = await identity.signData(payload)
  if (typeof signed === 'string') {
    throw new Error('dotrino-lobby: signData debe devolver { signature, publickey, chain } (vault ≥ 0.84)')
  }
  if (!Array.isArray(signed.chain) || !signed.chain.length) {
    throw new Error('dotrino-lobby: la firma vino sin cadena; el registro no podría comprobar quién firma por ti')
  }
  return { sig: signed.signature, signer: signed.publickey, chain: signed.chain }
}

/** Firma mi mitad del recibo con el vault. → `{ sig, signer, chain }`. */
export async function signReceiptHalf (identity, a, b, ts) {
  return firmarMitad(identity, receiptPayload(a, b, ts))
}

// ── Evento de indicador derivado co-firmado (p.ej. ELO) ────────────
/** Payload canónico del evento que ambas partes firman (debe coincidir con el
 *  server de reputation: {op:'event', indicator, scope, a, b, outcome, ts}). */
export function eventPayload (indicator, scope, a, b, outcome, ts, aud) {
  // PARA QUIÉN es el evento va DENTRO de lo que firman los dos. Ponerlo al publicar no
  // valdría de nada: la firma no lo cubriría, y el registro rechaza lo que no le nombra.
  return { op: 'event', aud, indicator, scope, a, b, outcome, ts }
}

/** Firma mi mitad del evento con el vault. → `{ sig, signer, chain }`. */
export async function signEventHalf (identity, indicator, scope, a, b, outcome, ts, aud) {
  return firmarMitad(identity, eventPayload(indicator, scope, a, b, outcome, ts, aud))
}

/**
 * Promueve a un peer a contacto del vault (compartido entre apps del ecosistema)
 * y, si se pasa rating, lo atesta en el registro (con recibo si está disponible).
 */
export async function ratePlayer (identity, reputation, pubkey, valueOrIndicators, opts = {}) {
  if (identity && opts.addContact !== false) {
    try { await identity.addContact({ publickey: pubkey, nickname: opts.nickname, lastToken: opts.token }) } catch (_) {}
  }
  if (reputation && valueOrIndicators != null) {
    try {
      return await reputation.rate(pubkey, valueOrIndicators, { notes: opts.notes, receipt: opts.receipt })
    } catch (e) {
      // El server rechaza TODO el rating si el recibo es inválido. No perder el
      // rating: reintentar sin recibo (queda con txBound:false).
      if (opts.receipt) {
        try { return await reputation.rate(pubkey, valueOrIndicators, { notes: opts.notes }) } catch (_) {}
      }
      throw e
    }
  }
  return { ok: true, txBound: false }
}
