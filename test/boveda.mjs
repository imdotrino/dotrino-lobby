// UNA BÓVEDA DE MENTIRA CON LA CRIPTO DE VERDAD.
//
// La forma es la del núcleo de `@dotrino/identity` (vault/core.js): una llave de FIRMA
// ECDSA P-256 (la que identifica en el cable y firma el anuncio de la llave de cifrado)
// y una de CIFRADO ECDH P-256, con `encrypt`/`decrypt` en el mismo formato de sobre v2
// que abre `identitySealing`. No se simula nada: las firmas se verifican de verdad
// (el pilar comprueba el anuncio contra la pubkey a la que va a escribir) y el cifrado
// es ECDH + AES-GCM.
//
// Lo que NO es: el iframe. Aquí no hay bóveda remota, así que las llaves están en el
// proceso — que es exactamente el caso de un aparato headless (los bots).

import { makeDeviceKey, signWithDevice, makeDeviceEncKey, importDeviceEncKey } from '@dotrino/identity/capabilities'
import { verifyData } from '@dotrino/proxy-client'

const ECDH = { name: 'ECDH', namedCurve: 'P-256' }
const b64 = (b) => Buffer.from(b).toString('base64')
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'))
const subtle = globalThis.crypto.subtle

const encKeyId = async (encPub) =>
  b64(await subtle.digest('SHA-256', new TextEncoder().encode(encPub))).slice(0, 16)

export async function bovedaDeMentira (nickname) {
  const firma = await makeDeviceKey()
  const cifrado = await makeDeviceEncKey()
  const miPriv = await importDeviceEncKey(cifrado.encPrivateJwk)
  const retos = new Set()

  const compartida = async (peerEncPubStr) => {
    const pub = await subtle.importKey('jwk', JSON.parse(peerEncPubStr), ECDH, false, [])
    const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, miPriv, 256)
    return subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  }

  return {
    me: { publickey: firma.publickey, nickname, encryptionPubkey: cifrado.encPublickey },

    signData: (data) => signWithDevice({ privateJwk: firma.privateJwk, publickey: firma.publickey, data }),
    getEncryptionPubkey: async () => cifrado.encPublickey,

    // ── Sobre v2, igual que el núcleo: una llave de contenido al azar, y una
    //    envoltura por destinatario derivada por ECDH.
    async encrypt (recipients, plaintext) {
      const k = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
      const kRaw = await subtle.exportKey('raw', k)
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(plaintext))
      const wrap = {}
      for (const r of recipients || []) {
        if (!r || !r.encryptionPubkey) continue
        const shared = await compartida(r.encryptionPubkey)
        const wIv = globalThis.crypto.getRandomValues(new Uint8Array(12))
        const wCt = await subtle.encrypt({ name: 'AES-GCM', iv: wIv }, shared, kRaw)
        wrap[await encKeyId(r.encryptionPubkey)] = { iv: b64(wIv), ct: b64(new Uint8Array(wCt)) }
      }
      return { v: 2, iv: b64(iv), ct: b64(new Uint8Array(ct)), wrap }
    },

    async decrypt (senderEncryptionPubkey, _myToken, envelope) {
      const mio = envelope.wrap && envelope.wrap[await encKeyId(cifrado.encPublickey)]
      if (!mio) throw new Error('this device is not among the message recipients')
      const shared = await compartida(senderEncryptionPubkey)
      const kRaw = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(mio.iv) }, shared, unb64(mio.ct))
      const k = await subtle.importKey('raw', kRaw, { name: 'AES-GCM' }, false, ['decrypt'])
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.iv) }, k, unb64(envelope.ct))
      return { plaintext: new TextDecoder().decode(pt) }
    },

    // ── Reto/respuesta: el anti-suplantación de la sala, firmado de verdad.
    async makeChallenge () {
      const nonce = b64(globalThis.crypto.getRandomValues(new Uint8Array(16)))
      retos.add(nonce)
      return { nonce }
    },
    async signChallenge (nonce) {
      const { signature } = await signWithDevice({ privateJwk: firma.privateJwk, publickey: firma.publickey, data: { nonce } })
      return { nonce, publickey: firma.publickey, signature, encryptionPubkey: cifrado.encPublickey }
    },
    async verifyResponse ({ nonce, publickey, signature } = {}) {
      if (!retos.has(nonce)) return { ok: false }
      retos.delete(nonce)
      const ok = await verifyData(publickey, { nonce }, signature)
      return { ok, publickey }
    },

    listContacts: async () => [],
    addContact: async () => ({ publickey: firma.publickey }),
    setRating: async () => ({})
  }
}
