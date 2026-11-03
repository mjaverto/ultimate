// Ultimate's service worker: shows the push notifications of the `notifications` extension, keeps the app badge,
// and opens a notification's conversation when it is tapped. It never handles fetches: the app hot-reloads, and
// nothing may be cached or intercepted.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// The server sends Declarative Web Push JSON, `{ web_push: 8030, notification: { title, body, navigate, tag },
// app_badge }`. Every push shows a notification, even a malformed one: iOS revokes the subscription of a service
// worker that shows none. The badge is best effort.
self.addEventListener('push', (event) => {
  let message
  try {
    message = event.data?.json()
  } catch {
    // A payload that is no JSON still shows, as a plain Ultimate notification.
  }
  const notification = message?.notification ?? {}
  const shown = self.registration.showNotification(
    typeof notification.title === 'string' && notification.title ? notification.title : 'Ultimate',
    {
      body: typeof notification.body === 'string' ? notification.body : undefined,
      tag: typeof notification.tag === 'string' ? notification.tag : undefined,
      icon: '/icons/icon-192.png',
      data: { url: notification.navigate },
    },
  )
  event.waitUntil(Promise.all([shown, badge(message?.app_badge)]))
})

/** Sets the app badge to `count`, or clears it at 0; a browser without badging, or one that refuses, keeps its own. */
async function badge(count) {
  if (typeof count !== 'number' || !('setAppBadge' in navigator)) return
  try {
    await (count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge())
  } catch {
    // Badging is best effort: the notification is what the push is for.
  }
}

// A tap opens the notification's link: in an open window of the app, which the page navigates itself, or else a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL(event.notification.data?.url ?? '/', self.location.origin).href
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = windows.find((client) => client.focused) ?? windows[0]
      if (open) {
        await open.focus()
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- A Client's postMessage has no target origin.
        open.postMessage({ type: 'notifications:open', url })
      } else await self.clients.openWindow(url)
    })(),
  )
})
