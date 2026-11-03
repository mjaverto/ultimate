Web Push notifications bring questions, @ultimate's finished answers and failed runs, and landings to each device, with an app-icon badge counting questions waiting on the user.

## The bell

Use the bell in the status line to turn notifications on or off for this device. Turning them on asks the browser's
permission, then subscribes this browser to this project's pushes. All four kinds start on: questions, finished
answers, failures and landings. The checkboxes change only this device's kinds. **Send test** sends “Notifications
are on for this device.” even while the app is on screen, and reports the push service's HTTP status.

Questions from any local conversation notify, titled by the asking branch or “Ultimate”. One-way messages notify
only when @ultimate sends them to the user. @ultimate's answers to internal inputs do not notify. Its failed runs
and every landing notify too. Previews are limited to about 180 characters; opening a notification opens the relevant
conversation on the origin that subscribed, a question's at the question while it is open
(`/?conversation=<c>&message=<m>`, see [Messages](../messages/README.md)). Notification previews can appear on the
device's lock screen.

An on-screen device gets no automatic push: each page reports itself every 10 seconds while shown and once when it
hides, and a visible report less than 15 seconds old from any page of that browser suppresses sending (its tabs share
one subscription). Other devices still receive it. There is no silent badge-only push.

## Badge and platforms

The badge is the number of open questions waiting on the user, read at send time, not the number of unread messages.
The open app also refreshes its badge. After answering on another device, a closed app's badge can stay stale until
the next push or until that app opens. Each origin (including a different project address or port) has its own
subscription and badge.

- iOS and iPadOS 16.4+ support Web Push only in an app added to the home screen, with permission requested after a
  tap. A normal Safari tab cannot subscribe. Use HTTPS outside localhost.
- iOS and iPadOS 18.4+ support Declarative Web Push: the system can show the payload itself, without running the
  service worker. Other supported browsers show the same notification through the service worker.
- Every push must show a notification. A service worker that receives pushes without showing notifications can
  have its subscription revoked. OS notification settings and Focus modes still control delivery and display.
- The page re-sends its current subscription on every launch because iOS Safari has no `pushsubscriptionchange`.
- Desktop browsers support Web Push where the Push API and notification permission are available; app-icon
  badging depends on the browser and installation mode.

## Server state and key rotation

The first `key` action creates the user-global `WEB_PUSH_VAPID_KEY` secret: a base64url-encoded 32-byte P-256 private
scalar. It is generated automatically, not a key to add by hand. Only its uncompressed public key is returned to the
browser. Deleting the secret in **Secrets** rotates the key on the next setup; every device must turn notifications
off and on again to subscribe with the new public key. Because the key is user-global, rotation affects every
project using it.

`notifications.devices` is a private, latest-only document on the root conversation. It stores endpoints,
subscription encryption keys, browser labels, page origins, per-device kinds and subscription times. It is not
exported to the browser's document stream. Subscriptions upsert by endpoint and keep existing kinds unless supplied.
Visibility reports, seen terminal-run keys and VAPID JWTs live only in process memory. Opening the server seeds the
current terminal-run key so a restart does not re-send an old answer or failure. Message and landing reactors start
from now rather than notifying for historical events.

## Sending

There is no added dependency: `node:crypto` implements P-256 ECDH, RFC 8291 single-record `aes128gcm` encryption and
ES256 VAPID signing. Each message has a fresh ephemeral key and salt. VAPID tokens expire after 12 hours and are
reused for 11 hours per push-service audience and subscribing page origin; the JWT subject is that page origin.

Pushes POST encrypted Declarative Web Push JSON (`web_push: 8030`, `notification`, top-level `app_badge`, no
`mutable`) with a one-day TTL. Questions and failures have high urgency; other kinds have normal urgency. Network
sending runs outside reactor transactions. HTTP 404 or 410 removes the subscription; other non-2xx responses report
a notice with the device label, status and first 200 response-body characters. Network failures also report a notice;
there is no retry loop. A push accepted by the service does not guarantee the OS displayed it.

All actions are user-only: `key` returns `{ key }`; `subscribe` takes `{ subscription, origin, kinds? }` and returns
the device without encryption keys; `unsubscribe` takes `{ endpoint }` and returns `{ removed }`; `test` takes
`{ endpoint }` and returns `{ status }`; `present` takes `{ endpoint, page, visible }` and returns `null`.
