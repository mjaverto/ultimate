import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  sign,
} from 'node:crypto'
import type { PushSubscriptionJson } from './refs.ts'

/** The uncompressed P-256 public key for a base64url private scalar. */
export function publicKey(privateKey: string) {
  const scalar = Buffer.from(privateKey, 'base64url')
  if (scalar.length !== 32) throw new Error('WEB_PUSH_VAPID_KEY must be a 32-byte P-256 scalar')
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(scalar)
  return ecdh.getPublicKey()
}

/** RFC 8291's single aes128gcm record; pinned ephemeral key and salt are only for test vectors. */
export function encrypt(
  plaintext: Uint8Array,
  keys: PushSubscriptionJson['keys'],
  serverKey?: Uint8Array,
  salt = randomBytes(16),
) {
  // 4096 bytes is the push service's minimum supported body size, including the 86-byte header and 17-byte overhead.
  if (plaintext.length > 3993) throw new Error('Web Push payload exceeds 3993 bytes')
  if (salt.length !== 16) throw new Error('Web Push salt must be 16 bytes')
  const uaPub = Buffer.from(keys.p256dh, 'base64url')
  const auth = Buffer.from(keys.auth, 'base64url')
  if (uaPub.length !== 65 || uaPub[0] !== 4 || auth.length !== 16)
    throw new Error('Invalid Web Push subscription keys')
  const ecdh = createECDH('prime256v1')
  if (serverKey) ecdh.setPrivateKey(serverKey)
  else ecdh.generateKeys()
  const asPub = ecdh.getPublicKey()
  const ikm = hkdfSync(
    'sha256',
    ecdh.computeSecret(uaPub),
    auth,
    Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]),
    32,
  )
  const cek = hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  const header = Buffer.alloc(21)
  salt.copy(header)
  header.writeUInt32BE(4096, 16)
  header[20] = asPub.length
  return Buffer.concat([header, asPub, ciphertext])
}

/** A 12-hour ES256 VAPID JWT, with the page's origin as its contact URI. `now` is epoch ms. */
export function vapidToken(privateKey: string, endpoint: string, origin: string, now = Date.now()) {
  const pub = publicKey(privateKey)
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: privateKey,
      x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  })
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const data = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: origin,
  })}`
  const signature = sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' })
  return `${data}.${signature.toString('base64url')}`
}

export type VapidCache = Map<string, { privateKey: string; token: string; at: number }>
export type PushPayload = {
  web_push: 8030
  notification: { title: string; body: string; navigate: string; tag: string }
  app_badge: number
}

/** Send once; the caller removes expired subscriptions and reports other push-service failures. */
export async function sendPush({
  subscription,
  origin,
  privateKey,
  payload,
  urgency,
  cache,
  signal,
}: {
  subscription: PushSubscriptionJson
  origin: string
  privateKey: string
  payload: PushPayload
  urgency: 'high' | 'normal'
  cache: VapidCache
  signal?: AbortSignal
}) {
  const now = Date.now()
  // Subjects differ when the same project is opened through more than one origin.
  const audience = `${new URL(subscription.endpoint).origin}\n${origin}`
  let cached = cache.get(audience)
  if (!cached || cached.privateKey !== privateKey || now - cached.at >= 11 * 60 * 60 * 1000) {
    cached = {
      privateKey,
      token: vapidToken(privateKey, subscription.endpoint, origin, now),
      at: now,
    }
    cache.set(audience, cached)
  }
  const response = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `vapid t=${cached.token}, k=${publicKey(privateKey).toString('base64url')}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: urgency,
    },
    body: encrypt(Buffer.from(JSON.stringify(payload)), subscription.keys),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
    redirect: 'error',
  })
  const removed = response.status === 404 || response.status === 410
  const error = !response.ok && !removed ? (await response.text()).slice(0, 200) : undefined
  if (error === undefined) await response.body?.cancel()
  return { status: response.status, removed, ...(error === undefined ? {} : { error }) }
}
