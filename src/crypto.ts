// Web Crypto only, so this runs in Node, Convex actions and Cloudflare Workers.

const enc = new TextEncoder()
const dec = new TextDecoder()

export const b64url = (b: Uint8Array) => {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)))

export async function sha256(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))))
}

export async function sha256hex(s: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join('')
}

/** AES-256-GCM with the app's key: 32 bytes, as base64 or base64url text (for example `openssl rand -base64 32`). */
export async function importKey(secret: string): Promise<CryptoKey> {
  const raw = unb64url(secret.trim().replace(/=+$/, ''))
  if (raw.length !== 32) throw new Error('byoa: the encryption key must be 32 bytes, as base64 (openssl rand -base64 32)')
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** `aad`: what the text is for (its store key), so one stored grant cannot be moved under another user's key. */
export async function seal(key: CryptoKey, text: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(text))
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(ct))}`
}

export async function open(key: CryptoKey, sealed: string, aad: string): Promise<string> {
  const [v, iv, ct] = sealed.split('.')
  if (v !== 'v1' || !iv || !ct) throw new Error('byoa: a stored grant is not in a format this version reads')
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64url(iv), additionalData: enc.encode(aad) }, key, unb64url(ct))
  return dec.decode(pt)
}
