/**
 * Notifications in the browser: the actions the status-line bell and the page use to subscribe this device to the
 * project's push notifications, keep its subscription current and report when it is on screen. Browser-safe.
 */
import { actionRef } from '../../shared/extension-api.ts'

/** What a push is about: a question waiting on the user, @ultimate's finished answer, its failed run, a landing. */
export type Kind = 'input' | 'finished' | 'failed' | 'landed'

/** A browser's push subscription, as `PushSubscription.toJSON()` gives it. */
export type PushSubscriptionJson = { endpoint: string; keys: { p256dh: string; auth: string } }

/** A device subscribed to this project's pushes, without its keys, which stay on the server. */
export type Device = {
  endpoint: string
  /** The browser it subscribed from, `phone safari`. */
  label: string
  /** The page's origin, `https://ultimate.example.com`: the base of each notification's link and the VAPID subject. */
  origin: string
  /** What it is told about; every kind for a new device. */
  kinds: Kind[]
  /** When it subscribed, epoch ms. */
  at: number
}

/**
 * `null` → `{ forward }`: whether the user's settings forward notifications to a webhook (`notifications.forward`).
 * Then the page has no push of its own: no service worker, bell or badge.
 */
export const ModeAction = actionRef<null, { forward: boolean }>('notifications', 'mode')
/** `null` → `{ key }`: the application server key to subscribe with (base64url, uncompressed P-256), made on first call. User-only. */
export const KeyAction = actionRef<null, { key: string }>('notifications', 'key')
/**
 * `{ subscription, origin, kinds? }` → the device: add this browser's subscription or refresh it, keeping its kinds
 * unless `kinds` is given. The page sends it on every launch, since iOS never reports a changed subscription. User-only.
 */
export const SubscribeAction = actionRef<
  { subscription: PushSubscriptionJson; origin: string; kinds?: Kind[] },
  Device
>('notifications', 'subscribe')
/** `{ endpoint }` → `{ removed }`: stop pushing to that device. User-only. */
export const UnsubscribeAction = actionRef<{ endpoint: string }, { removed: boolean }>(
  'notifications',
  'unsubscribe',
)
/** `{ endpoint }` → `{ status }`: push a test notification to that device now; `status` is the push service's HTTP status. User-only. */
export const TestAction = actionRef<{ endpoint: string }, { status: number }>(
  'notifications',
  'test',
)
/**
 * `{ endpoint, page, visible }` → `null`: page `page` (one id per page load) of that device is on screen (sent when it
 * shows and every 10 s while shown) or hidden. A device with any page reported on screen within the last 15 s gets no
 * push. User-only.
 */
export const PresentAction = actionRef<{ endpoint: string; page: string; visible: boolean }, null>(
  'notifications',
  'present',
)
