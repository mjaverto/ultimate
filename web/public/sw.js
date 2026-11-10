// Ultimate's service worker. It serves two push extensions and the share target:
// - `notifications` (this fork): Declarative Web Push JSON, `{ web_push: 8030, notification: { title, body, navigate,
//   tag }, app_badge }`, with the app badge; a tap opens the conversation (`notifications:open`).
// - `push` (upstream, off by default): `{ title, body, tag, path, message?, approve? }`, with Approve and an inline
//   Reply on a question; a tap opens the app (`ultimate:open`).
// - The manifest's `share_target` posts here; that POST is the only fetch it handles. It caches nothing else: every
//   page load still goes to the server, so the reload onto a new bundle (server/web.ts) works as without it.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

// Every push shows a notification, even a malformed one: iOS revokes the subscription of a service worker that shows
// none. A payload with a `notification` object is the notifications extension's; anything else is the push extension's.
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data?.json() ?? {}
  } catch {
    // A payload that is no JSON still shows, as a plain Ultimate notification.
  }
  if (data && typeof data.notification === 'object' && data.notification !== null) {
    const notification = data.notification
    const shown = self.registration.showNotification(
      typeof notification.title === 'string' && notification.title
        ? notification.title
        : 'Ultimate',
      {
        body: typeof notification.body === 'string' ? notification.body : undefined,
        tag: typeof notification.tag === 'string' ? notification.tag : undefined,
        icon: '/icons/icon-192.png',
        data: { url: notification.navigate },
      },
    )
    event.waitUntil(Promise.all([shown, badge(data.app_badge)]))
    return
  }
  const actions = []
  if (typeof data.message === 'number') {
    if (Array.isArray(data.approve)) actions.push({ action: 'approve', title: 'Approve' })
    // `type: 'text'` is Chrome's inline reply (Android and desktop, since Chrome 75,
    // https://chromestatus.com/feature/5743740178137088); other browsers show a plain button, which opens the question.
    actions.push({ action: 'reply', type: 'text', title: 'Reply', placeholder: 'Reply…' })
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Ultimate', {
      body: typeof data.body === 'string' ? data.body : undefined,
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      icon: '/icons/icon-192.png',
      actions,
      data,
    }),
  )
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

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification
  const data = notification.data ?? {}
  // The notifications extension's tap: open its link.
  if (
    typeof data.url === 'string' ||
    (data.url === undefined && data.path === undefined && data.message === undefined)
  ) {
    notification.close()
    event.waitUntil(open(data.url ?? '/', 'notifications:open'))
    return
  }
  const reply = event.action === 'reply' && typeof event.reply === 'string' && event.reply.trim()
  if (typeof data.message === 'number' && (event.action === 'approve' || reply)) {
    event.waitUntil(
      answer(
        notification,
        data,
        event.action === 'approve' ? { answers: data.approve } : { text: reply },
      ),
    )
    return
  }
  notification.close()
  event.waitUntil(open(data.path || '/', 'ultimate:open'))
})

/**
 * Answers question `data.message` through the questions extension's `answer` action, as its card does. The request is
 * same-origin, so Tailscale Serve adds the user's identity and the server admits it like the page's own. Android keeps
 * a replied notification spinning until it is replaced: success closes it, a failure replaces it with the reason.
 */
async function answer(notification, data, args) {
  let error
  try {
    const response = await fetch('/api/extensions/questions/actions/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: { messageId: data.message, ...args } }),
    })
    if (!response.ok)
      error = (await response.json().catch(() => ({}))).error ?? `HTTP ${response.status}`
  } catch (caught) {
    error = String(caught)
  }
  if (error === undefined) {
    notification.close()
    return
  }
  await self.registration.showNotification(data.title || 'Ultimate', {
    body: `Not answered: ${error}`,
    tag: data.tag,
    icon: '/icons/icon-192.png',
    data: { path: data.path },
  })
}

/**
 * Opens `path` in a window of the app: an open one is told to navigate itself (`type` is the message its extension's
 * page listens for), else a new window opens.
 */
async function open(path, type) {
  const url = new URL(path, self.location.origin).href
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const shown = windows.find((client) => client.focused) ?? windows[0]
  if (!shown) {
    await self.clients.openWindow(url)
    return
  }
  await shown.focus()
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- A Client's postMessage has no target origin.
  shown.postMessage({ type, url })
}

// The share target posts its form here (manifest.webmanifest). The page reads it from the cache and deletes it
// (extensions/share).
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (
    event.request.method === 'POST' &&
    url.origin === self.location.origin &&
    url.pathname === '/share'
  )
    event.respondWith(share(event.request))
})

async function share(request) {
  const form = await request.formData()
  const id = crypto.randomUUID()
  const cache = await caches.open('ultimate-share')
  const files = form.getAll('files').filter((file) => file instanceof File && file.size > 0)
  await Promise.all(
    files.map((file, index) => cache.put(`/share/${id}/${index}`, new Response(file))),
  )
  const field = (name) => (typeof form.get(name) === 'string' ? form.get(name) : '')
  await cache.put(
    `/share/${id}`,
    Response.json({
      title: field('title'),
      text: field('text'),
      url: field('url'),
      files: files.map((file) => ({ name: file.name, type: file.type })),
    }),
  )
  return Response.redirect(`/?share=${id}`, 303)
}
