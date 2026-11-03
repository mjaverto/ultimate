import type { JsonObject } from '@earendil-works/pi-durable'
import { readSecret } from '../../lib/secrets.ts'
import type { Notification } from './rules.ts'

/** `notifications.forward` in the user's settings: a webhook that gets every notification instead of this project's devices. */
export type Forward = { url: string; headers: Record<string, string> }

/** What the webhook receives, as JSON: one notification of the project whose home folder is `project`. */
export type Ingest = Pick<Notification, 'kind' | 'title' | 'body' | 'conversation' | 'tag'> & {
  project: string
  message?: number
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** The forward setting, or undefined when notifications push to this project's own devices. */
export function forwardSetting(settings: JsonObject): Forward | undefined {
  const value = isObject(settings.notifications) ? settings.notifications.forward : undefined
  if (value === undefined) return undefined
  if (
    !isObject(value) ||
    typeof value.url !== 'string' ||
    !URL.canParse(value.url) ||
    !['http:', 'https:'].includes(new URL(value.url).protocol)
  )
    throw new Error('notifications.forward must be { url, headers? } with an HTTP(S) url')
  const headers = value.headers ?? {}
  if (!isObject(headers) || Object.values(headers).some((header) => typeof header !== 'string'))
    throw new Error('notifications.forward.headers must map names to strings')
  return { url: value.url, headers: headers as Record<string, string> }
}

export function ingest(project: string, notification: Notification): Ingest {
  const { kind, title, body, conversation, message, tag } = notification
  return {
    project,
    kind,
    title,
    body,
    conversation,
    ...(message === undefined ? {} : { message }),
    tag,
  }
}

const SECRET = /\$\{([A-Z][A-Z0-9_]*)\}/g

/** `${NAME}` in a header value is the environment variable NAME, else the secret NAME from the Secrets panel. */
async function expand(headers: Record<string, string>, userHome: string, env: NodeJS.ProcessEnv) {
  const values = new Map<string, string>()
  for (const [, name] of Object.values(headers).join('\n').matchAll(SECRET)) {
    const value = env[name] || (await readSecret(userHome, name))
    if (!value)
      throw new Error(
        `notifications.forward needs ${name}: set it in the environment or add it in the Secrets panel`,
      )
    values.set(name, value)
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      value.replace(SECRET, (_token, name: string) => values.get(name)!),
    ]),
  )
}

/** POST one notification once; the caller reports a failed status. No retry: notifications are at most once. */
export async function forward(target: Forward, body: Ingest, userHome: string, env = process.env) {
  const headers = await expand(target.headers, userHome, env)
  try {
    const response = await fetch(target.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    })
    return { status: response.status, text: (await response.text()).slice(0, 500) }
  } catch (error) {
    // Fetch quotes a header value it refuses, which can be a secret: report only the network code or the error's name.
    const { name, cause } = error as Error & { cause?: { code?: unknown } }
    throw new Error(
      `notifications.forward failed: ${typeof cause?.code === 'string' ? cause.code : name}`,
    )
  }
}
