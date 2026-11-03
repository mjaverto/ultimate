import { BellIcon, BellOffIcon, SendIcon } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { api, cn, defineWebExtension, errorMessage, useDocOf, useUltimate } from '@/sdk'
import { MessagesDoc } from '../messages/ui.tsx'
import {
  KeyAction,
  ModeAction,
  PresentAction,
  SubscribeAction,
  TestAction,
  UnsubscribeAction,
} from './refs.ts'
import type { Device, Kind, PushSubscriptionJson } from './refs.ts'

/** Each kind of push, in the order and words of the sounds' cues. */
const kinds: { kind: Kind; label: string }[] = [
  { kind: 'input', label: 'Needs input' },
  { kind: 'finished', label: 'Finished' },
  { kind: 'failed', label: 'Failed' },
  { kind: 'landed', label: 'Landed' },
]

/** What this browser has: its service worker, its push subscription and the device the server keeps for it. */
type Here = {
  /** Notifications go to a webhook instead (`notifications.forward`): this page has no push. Unknown until asked. */
  forward?: boolean
  registration?: ServiceWorkerRegistration
  subscription?: PushSubscription
  /** Set once the server confirmed the subscription: this device is on. */
  device?: Device
  /** The application server key, fetched when the popover opens, so that a tap subscribes without waiting. */
  key?: string
  /** Why registering, subscribing, saving or testing last failed. */
  error?: string
}

let here: Here = {}
const listeners = new Set<() => void>()
const update = (change: Partial<Here>) => {
  here = { ...here, ...change }
  for (const listener of listeners) listener()
}
const watch = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}
const useHere = () => useSyncExternalStore(watch, () => here)

const json = (subscription: PushSubscription) => subscription.toJSON() as PushSubscriptionJson

/** A base64url key as the bytes `pushManager.subscribe` takes. */
const bytes = (key: string) =>
  Uint8Array.from(atob(key.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))

const failed = (error: unknown) => update({ error: errorMessage(error) })

let launched = false

/**
 * Unless notifications are forwarded, registers the service worker and, when this browser is subscribed with
 * permission granted, sends its subscription again: iOS never reports a changed one, so every launch refreshes it on
 * the server, which answers with the device.
 */
function launch() {
  if (launched) return
  launched = true
  api
    .action(ModeAction, null)
    .then(async ({ forward }) => {
      update({ forward })
      if (forward || !('serviceWorker' in navigator)) return
      const registration = await navigator.serviceWorker.register('/sw.js')
      update({ registration })
      // A Safari tab on iOS has a service worker but no push.
      if (!('PushManager' in window)) return
      const subscription = await registration.pushManager.getSubscription()
      if (!subscription || Notification.permission !== 'granted') return
      update({ subscription })
      update({
        device: await api.action(SubscribeAction, {
          subscription: json(subscription),
          origin: location.origin,
        }),
      })
    })
    .catch(failed)
}

/** Launches on mount; the page's push runs only once it is known that notifications are not forwarded. */
function Pushes() {
  const { forward } = useHere()
  useEffect(() => launch(), [])
  return forward === false ? <Pusher /> : null
}

/** Sets the app badge to `count`, or clears it at 0, where the browser badges (an installed app). */
function badge(count: number) {
  if (!('setAppBadge' in navigator)) return
  const set = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge()
  // A browser may refuse a page that is no installed app; the badge is best effort.
  set.catch((error: unknown) => console.warn('App badge', error))
}

/** How often a shown page tells the server it is on screen; the server skips a device seen within 15 s. */
const presentMs = 10_000
/** This page load among the browser's tabs, which share one subscription. */
const page = Math.random().toString(36).slice(2)

/**
 * Always mounted, renders nothing: registers the service worker, keeps the app badge at the questions waiting on the
 * user and closes the notifications of those answered, reports while a subscribed page is on screen, and opens the
 * conversation of a tapped notification.
 */
function Pusher() {
  const { registration, device } = useHere()
  const log = useDocOf(1, MessagesDoc)
  const { showSurface, switchConversation } = useUltimate()
  // The questions to the user; those delivered wait on them, by the rule of the server's `openQuestions`. Until the
  // messages arrive nothing is known, so the badge stays as it was.
  const questions = log?.messages.filter(
    (m) => m.to === 'user' && m.reply && typeof m.from === 'number',
  )
  const count = questions?.filter((m) => m.state === 'delivered').length
  useEffect(() => {
    if (count !== undefined) badge(count)
  }, [count])
  // The notification of a question closes once it no longer waits: answered, dismissed or ended. A one-way message
  // shares the `message:<id>` tag and never waited, so its notification stays.
  const settled = questions
    ?.filter((m) => m.state !== 'sent' && m.state !== 'delivered')
    .map((m) => `message:${m.id}`)
    .join(' ')
  useEffect(() => {
    if (!settled || !registration) return
    const tags = new Set(settled.split(' '))
    registration
      .getNotifications()
      .then((shown) => {
        for (const notification of shown) if (tags.has(notification.tag)) notification.close()
      })
      .catch((error: unknown) => console.warn('Closing answered notifications', error))
  }, [settled, registration])
  const endpoint = device?.endpoint
  useEffect(() => {
    if (!endpoint) return undefined
    const report = (visible: boolean) => {
      api
        .action(PresentAction, { endpoint, page, visible }, { keepalive: !visible })
        // A missed report costs one push or one skipped push at worst; the next one corrects it.
        .catch((error: unknown) => console.warn('Notifications presence', error))
    }
    const tick = () => {
      if (document.visibilityState === 'visible') report(true)
    }
    const changed = () => report(document.visibilityState === 'visible')
    const hide = () => report(false)
    tick()
    const timer = setInterval(tick, presentMs)
    document.addEventListener('visibilitychange', changed)
    window.addEventListener('pagehide', hide)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', changed)
      window.removeEventListener('pagehide', hide)
    }
  }, [endpoint])
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined
    const opened = (event: MessageEvent<{ type?: string; url?: string }>) => {
      if (event.data?.type !== 'notifications:open' || !event.data.url) return
      const id = Number(new URL(event.data.url, location.href).searchParams.get('conversation'))
      if (!Number.isInteger(id) || id <= 0) return
      showSurface('agent')
      switchConversation(id)
    }
    navigator.serviceWorker.addEventListener('message', opened)
    return () => navigator.serviceWorker.removeEventListener('message', opened)
  }, [showSurface, switchConversation])
  return null
}

/** An iPhone or iPad; an iPad reports itself as a Mac with touch. */
const apple = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)

/** Why this browser cannot be turned on, or nothing. */
function blocked() {
  if (apple() && (navigator as Navigator & { standalone?: boolean }).standalone !== true)
    return 'Add Ultimate to your Home Screen and open it from there to get notifications.'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window))
    return "This browser can't receive push notifications."
  if (Notification.permission === 'denied')
    return 'Notifications are blocked for this site; allow them in Settings.'
  return undefined
}

/** Fetches the key to subscribe with; it creates the server's key the first time, so only an open popover asks. */
function fetchKey() {
  update({ error: undefined })
  api
    .action(KeyAction, null)
    .then(({ key }) => update({ key }))
    .catch(failed)
}

/** Subscribes this browser. Called straight from the tap, nothing awaited before: iOS subscribes only in a gesture. */
function turnOn(registration: ServiceWorkerRegistration, key: string) {
  update({ error: undefined })
  registration.pushManager
    .subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) })
    .then(async (subscription) => {
      update({ subscription })
      update({
        device: await api.action(SubscribeAction, {
          subscription: json(subscription),
          origin: location.origin,
        }),
      })
    })
    .catch(failed)
}

/** Unsubscribes this browser and drops its device on the server. */
async function turnOff() {
  const { subscription, device } = here
  update({ error: undefined })
  // The browser's subscription goes first and stays on screen until it is gone: once it is, the push service answers
  // 404/410 and the server drops the device even if removing it below fails.
  await subscription?.unsubscribe()
  update({ subscription: undefined, device: undefined })
  if (device) await api.action(UnsubscribeAction, { endpoint: device.endpoint })
}

/** Saves which kinds this device is told about, showing them at once. */
function save(chosen: Kind[]) {
  const { subscription, device } = here
  if (!subscription || !device) return
  update({ device: { ...device, kinds: chosen }, error: undefined })
  api
    .action(SubscribeAction, {
      subscription: json(subscription),
      origin: location.origin,
      kinds: chosen,
    })
    .then((saved) => update({ device: saved }))
    .catch((error: unknown) => update({ device, error: errorMessage(error) }))
}

const row = 'flex h-8 items-center justify-between gap-2 px-2 text-[12px]'
const section = 'border-t border-border/70 pt-1'

/** The status-bar entry: notifications on this device, which kinds, a test push, and why it cannot be on. */
function Control() {
  const { registration, device, key, error } = useHere()
  const [test, setTest] = useState<string>()
  const on = device !== undefined
  const reason = blocked()
  const hint = reason ?? error
  const opened = (open: boolean) => {
    if (!open) return
    setTest(undefined)
    if (!key && !on && !reason) fetchKey()
  }
  const toggle = (next: boolean) => {
    if (!next) turnOff().catch(failed)
    else if (registration && key) turnOn(registration, key)
  }
  const sendTest = () => {
    if (!device) return
    setTest('Sending…')
    api
      .action(TestAction, { endpoint: device.endpoint })
      .then(({ status }) => setTest(status >= 200 && status < 300 ? 'Sent' : String(status)))
      .catch((caught: unknown) => {
        setTest('Failed')
        failed(caught)
      })
  }
  return (
    <Popover onOpenChange={opened}>
      <PopoverTrigger asChild>
        <button
          aria-label="Notifications"
          className={cn(
            '-mx-1 flex items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
            !on && 'text-muted-foreground/60',
          )}
          data-notifications={on ? 'on' : 'off'}
          type="button"
        >
          {on ? <BellIcon className="size-3" /> : <BellOffIcon className="size-3" />}
          notify
        </button>
      </PopoverTrigger>
      {/* Wider than the sounds' popover, so that the switch's label fits on one line. */}
      <PopoverContent align="end" className="w-72 p-1 font-mono" side="top">
        <label className={cn(row, 'cursor-pointer')}>
          Notifications on this device
          <Switch
            checked={on}
            disabled={!on && (reason !== undefined || !registration || !key)}
            onCheckedChange={toggle}
          />
        </label>
        {hint && (
          <div className="px-2 pb-1 text-[11px] leading-4 text-muted-foreground" role="status">
            {hint}
          </div>
        )}
        {device && (
          <>
            <div className={section}>
              {kinds.map(({ kind, label }) => (
                <label
                  className="flex h-7 cursor-pointer items-center gap-2 px-2 text-[12px]"
                  key={kind}
                >
                  <Checkbox
                    checked={device.kinds.includes(kind)}
                    onCheckedChange={(checked) =>
                      save(
                        kinds
                          .map((each) => each.kind)
                          .filter((each) =>
                            each === kind ? checked === true : device.kinds.includes(each),
                          ),
                      )
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className={section}>
              <button
                className={cn(
                  row,
                  'w-full cursor-pointer rounded-sm whitespace-nowrap hover:bg-accent',
                )}
                onClick={sendTest}
                type="button"
              >
                <span className="flex items-center gap-2">
                  <SendIcon className="size-3" />
                  Send test
                </span>
                {test && (
                  <span
                    className={cn(
                      'text-[11px] text-muted-foreground',
                      test !== 'Sent' && test !== 'Sending…' && 'text-error',
                    )}
                  >
                    {test}
                  </span>
                )}
              </button>
            </div>
          </>
        )}
        <div
          className={cn(section, 'px-2 pt-1.5 pb-1 text-[11px] leading-4 text-muted-foreground')}
        >
          Questions and landings from any branch; the rest from @ultimate. Skipped while this device
          shows Ultimate.
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** No bell while notifications are forwarded: the hub that receives them has its own. */
const Bell = () => (useHere().forward === false ? <Control /> : null)

export default defineWebExtension({
  slots: { overlay: [Pushes], 'statusline.right': [{ component: Bell, order: -1 }] },
})
