import { createECDH, createPublicKey, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encrypt, publicKey, vapidToken } from '../extensions/notifications/push.ts'
import {
  landingNotification,
  messageNotification,
  rowNotification,
} from '../extensions/notifications/rules.ts'

it('reproduces the complete RFC 8291 Appendix A encrypted body byte for byte', () => {
  const encrypted = encrypt(
    Buffer.from('When I grow up, I want to be a watermelon'),
    {
      p256dh:
        'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    },
    Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'),
    Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
  )
  const header = Buffer.from(
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
      'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    'base64url',
  )
  const ciphertext = Buffer.from(
    '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
    'base64url',
  )
  expect(header.length).toBe(86)
  expect(encrypted).toEqual(Buffer.concat([header, ciphertext]))
})

it('signs a VAPID JWT that verifies with the public key derived from a generated scalar', () => {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const scalar = Buffer.from(
    ecdh.getPrivateKey().toString('hex').padStart(64, '0'),
    'hex',
  ).toString('base64url')
  const pub = publicKey(scalar)
  expect(pub).toEqual(ecdh.getPublicKey())
  const token = vapidToken(
    scalar,
    'https://push.example.com/send/123',
    'https://app.example.com',
    0,
  )
  const [header, claims, signature] = token.split('.')
  expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
    typ: 'JWT',
    alg: 'ES256',
  })
  expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({
    aud: 'https://push.example.com',
    exp: 12 * 60 * 60,
    sub: 'https://app.example.com',
  })
  const key = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  })
  expect(
    verify(
      'sha256',
      Buffer.from(`${header}.${claims}`),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    ),
  ).toBe(true)
})

describe('notification rules', () => {
  const question = {
    id: 75,
    from: 8,
    to: 'user' as const,
    reply: true,
    text: '\n**Please choose.**\nMore context.',
    questions: [{ text: 'Which layout?', kind: 'choice' as const }],
  }

  it('names a branch question by its title and previews its first question', () => {
    expect(messageNotification(question, 2, 'A quieter sidebar')).toEqual({
      kind: 'input',
      title: 'A quieter sidebar',
      body: 'Which layout?',
      path: '/?conversation=8',
      tag: 'message:75',
    })
  })

  it("names @ultimate's question Ultimate", () => {
    expect(messageNotification({ ...question, from: 2 }, 2, 'Standing agent')).toEqual({
      kind: 'input',
      title: 'Ultimate',
      body: 'Which layout?',
      path: '/?conversation=2',
      tag: 'message:75',
    })
  })

  it("previews the first nonempty line of @ultimate's one-way message", () => {
    expect(
      messageNotification({ ...question, from: 2, reply: false, questions: undefined }, 2),
    ).toEqual({
      kind: 'finished',
      title: 'Ultimate',
      body: 'Please choose.',
      path: '/?conversation=2',
      tag: 'message:75',
    })
  })

  it.each([
    ['a branch one-way message', { ...question, reply: false }],
    ['a message not to the user', { ...question, to: 2 }],
    ['a remote message', { ...question, from: 'remote' as const }],
  ])('does not notify for %s', (_name, message) => {
    expect(messageNotification(message, 2)).toBeUndefined()
  })

  it('links a landing to its submitting conversation', () => {
    expect(
      landingNotification({ title: 'A quieter sidebar', conversationId: 8, sha: 'abc' }),
    ).toEqual({
      kind: 'landed',
      title: 'Landed',
      body: 'A quieter sidebar',
      path: '/?conversation=8',
      tag: 'landed:abc',
    })
  })

  it('announces an error in @ultimate', () => {
    expect(rowNotification({ runState: 'error', inputId: 12 }, 2, '')).toEqual({
      kind: 'failed',
      title: 'Ultimate',
      body: 'Stopped with an error.',
      path: '/?conversation=2',
      tag: 'failed:12',
    })
  })

  it("previews @ultimate's answer to the user's input", () => {
    expect(
      rowNotification({ runState: 'answered', answerId: 13 }, 2, '\n**Done.**\nDetails.'),
    ).toEqual({
      kind: 'finished',
      title: 'Ultimate',
      body: 'Done.',
      path: '/?conversation=2',
      tag: 'finished:13',
    })
  })

  it('does not notify for an answer to an internal input', () => {
    expect(
      rowNotification({ runState: 'answered', answerId: 13, internalInput: true }, 2, 'Done.'),
    ).toBeUndefined()
  })
})
