import { createECDH } from 'node:crypto'
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import { defineDoc, defineExtension, ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { EntryId } from '@earendil-works/pi-durable'
import { implementAction } from '../../lib/actions.ts'
import { onCommit } from '../../lib/commits.ts'
import { readSecret } from '../../lib/secrets.ts'
import type { ExtensionHost } from '../../server/extensions.ts'
import type { OverviewState } from '../conversations/types.ts'
import { Messages, MessagesApi, MessageSent } from '../messages/api.ts'
import { SecretsApi } from '../secrets/api.ts'
import { Standing } from '../subagents/api.ts'
import { SubmissionLanded } from '../workspaces/api.ts'
import { KeyAction, PresentAction, SubscribeAction, TestAction, UnsubscribeAction } from './refs.ts'
import type { Device, Kind, PushSubscriptionJson } from './refs.ts'
import { publicKey, sendPush } from './push.ts'
import type { VapidCache } from './push.ts'
import { firstLine, landingNotification, messageNotification, rowNotification } from './rules.ts'
import type { Notification } from './rules.ts'

const KEY = 'WEB_PUSH_VAPID_KEY'
const KINDS: Kind[] = ['input', 'finished', 'failed', 'landed']
const OVERVIEW = 'ultimate.conversation-overview'
type StoredDevice = Device & { keys: PushSubscriptionJson['keys'] }

/** Subscription secrets stay on the root and are never exported to the browser's document stream. */
const Devices = defineDoc<{ devices: StoredDevice[] }>({
  kind: 'notifications.devices',
  checkpointWhen: () => false,
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ devices: [] }),
})

const state = (host: ExtensionHost) =>
  host.resource('notifications.state', () => ({
    /** Per endpoint, when each of its pages last reported itself on screen; a hidden page is dropped. */
    presence: new Map<string, Map<string, number>>(),
    seen: new Set<string>(),
    sending: new Set<Promise<void>>(),
    vapid: new Map() as VapidCache,
    keying: undefined as Promise<string> | undefined,
  }))

async function key(host: ExtensionHost) {
  const shared = state(host)
  shared.keying ??= (async () => {
    let scalar = await readSecret(host.userHome, KEY)
    if (!scalar) {
      const ecdh = createECDH('prime256v1')
      ecdh.generateKeys()
      // ECDH omits leading zero bytes; the stored scalar is always exactly 32 bytes.
      scalar = Buffer.from(ecdh.getPrivateKey().toString('hex').padStart(64, '0'), 'hex').toString(
        'base64url',
      )
      await host.need(SecretsApi).set(KEY, scalar)
    }
    return publicKey(scalar).toString('base64url')
  })().finally(() => {
    shared.keying = undefined
  })
  return shared.keying
}

const devices = async (host: ExtensionHost) =>
  (await host.harness().snapshot(Devices, ROOT_CONVERSATION_ID, context))?.devices ?? []

async function remove(host: ExtensionHost, endpoint: string) {
  const removed = await host.harness().commit(async (tx) => {
    const doc = await tx.doc(Devices, ROOT_CONVERSATION_ID)
    const before = doc.devices.length
    doc.devices = doc.devices.filter((device) => device.endpoint !== endpoint)
    return doc.devices.length < before
  }, context)
  state(host).presence.delete(endpoint)
  return removed
}

async function sendDevice(
  host: ExtensionHost,
  device: StoredDevice,
  notification: Omit<Notification, 'kind'> & { kind?: Kind },
  signal?: AbortSignal,
) {
  const privateKey = await readSecret(host.userHome, KEY)
  if (!privateKey) throw new Error('Turn notifications on again to create WEB_PUSH_VAPID_KEY')
  const badge = (await host.need(MessagesApi).openQuestions(context)).length
  const result = await sendPush({
    subscription: { endpoint: device.endpoint, keys: device.keys },
    origin: device.origin,
    privateKey,
    payload: {
      web_push: 8030,
      notification: {
        title: notification.title,
        body: notification.body,
        navigate: `${device.origin}${notification.path}`,
        tag: notification.tag,
      },
      app_badge: badge,
    },
    urgency: notification.kind === 'input' || notification.kind === 'failed' ? 'high' : 'normal',
    cache: state(host).vapid,
    signal,
  })
  if (result.removed) await remove(host, device.endpoint)
  else if (result.error !== undefined)
    host.notice(`Notifications (${device.label}): ${result.status} ${result.error}`)
  return { status: result.status }
}

async function deliver(host: ExtensionHost, notification: Notification) {
  const shared = state(host)
  await Promise.all(
    (await devices(host)).map(async (device) => {
      if (!device.kinds.includes(notification.kind)) return
      const pages = shared.presence.get(device.endpoint)?.values() ?? []
      if ([...pages].some((at) => Date.now() - at < 15_000)) return
      try {
        await sendDevice(host, device, notification)
      } catch (error) {
        host.notice(`Notifications (${device.label}): ${String(error)}`)
      }
    }),
  )
}

/** Do not await network sends in a reactor's transaction. Track them so release/close drains before storage closes. */
function launch(host: ExtensionHost, notification: Notification) {
  const shared = state(host)
  const sending = deliver(host, notification)
    .catch((error: unknown) => host.notice(`Notifications: ${String(error)}`))
    .finally(() => shared.sending.delete(sending))
  shared.sending.add(sending)
}

async function currentRow(host: ExtensionHost) {
  const token = host.doc(OVERVIEW)
  if (!token) throw new Error(`Notifications needs document ${OVERVIEW}`)
  const [standing, overview] = await Promise.all([
    host.harness().snapshot(Standing, ROOT_CONVERSATION_ID, context),
    host.harness().snapshot(token, ROOT_CONVERSATION_ID, context),
  ])
  const ultimate = standing?.ultimate
  return {
    ultimate,
    row:
      ultimate === undefined
        ? undefined
        : (overview as OverviewState | undefined)?.conversations[ultimate],
  }
}

async function answerText(host: ExtensionHost, id: number) {
  const entry = await host.harness().commit((tx) => tx.entry(id as EntryId), context)
  return (entry?.model ?? [])
    .flatMap((message) =>
      message.role === 'assistant'
        ? message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : [],
    )
    .join('\n')
}

export default function notifications(host: ExtensionHost) {
  host.need(MessagesApi)
  host.need(SecretsApi)
  const shared = state(host)
  host.react(
    'messages',
    [MessageSent],
    async (tx, { data }) => {
      if (data.to !== 'user') return
      const message = (await tx.doc(Messages, ROOT_CONVERSATION_ID)).messages.find(
        (item) => item.id === data.message,
      )
      if (!message) return
      const ultimate = (await tx.doc(Standing, ROOT_CONVERSATION_ID)).ultimate
      const title = host
        .conversations()
        .find((conversation) => conversation.id === data.from)?.title
      const notification = messageNotification(message, ultimate, title)
      if (notification) launch(host, notification)
    },
    { from: 'now' },
  )
  host.react(
    'landings',
    [SubmissionLanded],
    (_tx, { data }) => {
      launch(host, landingNotification(data))
    },
    { from: 'now' },
  )

  let stop: (() => void) | undefined
  let opened = false
  let ready = false
  let dirty = false
  let checking: Promise<void> | undefined
  const check = async (seed: boolean) => {
    const { ultimate, row } = await currentRow(host)
    if (ultimate === undefined) return
    let notification = rowNotification(row, ultimate, '')
    if (!notification || (!seed && shared.seen.has(notification.tag))) return
    shared.seen.add(notification.tag)
    if (seed) return
    if (notification.kind === 'finished') {
      const answer = await answerText(host, row!.answerId!)
      // A run that ends by messaging the user answers with no text; that message notifies on its own.
      if (!firstLine(answer)) return
      notification = rowNotification(row, ultimate, answer)!
    }
    if (opened) launch(host, notification)
  }
  const schedule = () => {
    if (!opened || !ready || checking || !dirty) return
    checking = (async () => {
      while (dirty) {
        if (!opened) break
        dirty = false
        await check(false)
      }
    })()
      .catch((error: unknown) => host.notice(`Notifications: ${String(error)}`))
      .finally(() => {
        checking = undefined
        schedule()
      })
  }
  host.onOpen(async () => {
    opened = true
    // Not a reactor: @ultimate's terminal runs are Pi's overview document changes, not domain events.
    stop = onCommit(host.harness(), (publication) => {
      if (
        publication.changes.some(
          (change) =>
            change.type === 'document' &&
            change.conversationId === ROOT_CONVERSATION_ID &&
            change.record.kind === OVERVIEW,
        )
      ) {
        dirty = true
        schedule()
      }
    })
    // Opening/reloading must never send the already-finished answer or error as new news.
    await check(true)
    ready = true
    schedule()
  })
  const close = async () => {
    opened = false
    ready = false
    dirty = false
    stop?.()
    stop = undefined
    await checking
    // A reactor finishing during release may launch one more send: drain until none is left. One launched after
    // storage closed is lost; notifications are at most once.
    while (shared.sending.size) await Promise.all(shared.sending)
  }
  host.onRelease(close)
  host.onClose(close)
  return defineExtension({ name: 'notifications' })
}

function assertEndpoint(value: unknown): asserts value is string {
  if (typeof value !== 'string' || new URL(value).protocol !== 'https:')
    throw new Error('Expected an HTTPS push endpoint')
}

export const actions = {
  key: implementAction(KeyAction, async (_args, { host }) => ({ key: await key(host) })),
  subscribe: implementAction(SubscribeAction, async (args, { host, device }) => {
    if (!args || typeof args !== 'object' || Array.isArray(args))
      throw new Error('Expected { subscription, origin, kinds? }')
    const subscription = args.subscription as Partial<PushSubscriptionJson> | null | undefined
    assertEndpoint(subscription?.endpoint)
    const keys = subscription?.keys
    if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string')
      throw new Error('Expected subscription keys p256dh and auth')
    const origin = args.origin
    if (
      typeof origin !== 'string' ||
      !['http:', 'https:'].includes(new URL(origin).protocol) ||
      new URL(origin).origin !== origin
    )
      throw new Error('Expected an HTTP(S) origin without a path')
    const kinds = args.kinds
    if (
      kinds !== undefined &&
      (!Array.isArray(kinds) || kinds.some((kind) => !KINDS.includes(kind as Kind)))
    )
      throw new Error('Expected notification kinds: input, finished, failed, landed')
    const url = subscription.endpoint
    return host.harness().commit(async (tx) => {
      const doc = await tx.doc(Devices, ROOT_CONVERSATION_ID)
      const previous = doc.devices.find((item) => item.endpoint === url)
      const next: Device = {
        endpoint: url,
        origin,
        label: device?.device ?? 'browser',
        kinds: kinds === undefined ? [...(previous?.kinds ?? KINDS)] : [...(kinds as Kind[])],
        at: Date.now(),
      }
      doc.devices = doc.devices.filter((item) => item.endpoint !== url)
      doc.devices.push({ ...next, keys: { p256dh: keys.p256dh, auth: keys.auth } })
      return next
    }, context)
  }),
  unsubscribe: implementAction(UnsubscribeAction, async (args, { host }) => {
    const url = (args as { endpoint?: unknown } | null)?.endpoint
    assertEndpoint(url)
    return { removed: await remove(host, url) }
  }),
  test: implementAction(TestAction, async (args, { host, signal }) => {
    const url = (args as { endpoint?: unknown } | null)?.endpoint
    assertEndpoint(url)
    const device = (await devices(host)).find((item) => item.endpoint === url)
    if (!device) throw new Error('This device is not subscribed')
    return sendDevice(
      host,
      device,
      { title: 'Ultimate', body: 'Notifications are on for this device.', path: '/', tag: 'test' },
      signal,
    )
  }),
  present: implementAction(PresentAction, (args, { host }) => {
    if (!args || typeof args !== 'object' || Array.isArray(args))
      throw new Error('Expected { endpoint, page, visible }')
    assertEndpoint(args.endpoint)
    if (typeof args.page !== 'string' || !args.page || args.page.length > 64)
      throw new Error('Expected a page id of at most 64 characters')
    if (typeof args.visible !== 'boolean')
      throw new Error('Expected { endpoint, page, visible: boolean }')
    const { presence } = state(host)
    const pages = presence.get(args.endpoint) ?? new Map<string, number>()
    // Another tab of the same browser shares the endpoint: one hiding leaves the others on screen.
    const now = Date.now()
    for (const [page, at] of pages) if (now - at >= 15_000) pages.delete(page)
    if (args.visible) pages.set(args.page, now)
    else pages.delete(args.page)
    if (pages.size) presence.set(args.endpoint, pages)
    else presence.delete(args.endpoint)
    return null
  }),
}

/** Subscription permissions and device preferences belong to the user, never an agent. */
export const userActions = ['key', 'subscribe', 'unsubscribe', 'test', 'present']
