import type { Message } from '../messages/api.ts'
import type { OverviewRow } from '../conversations/types.ts'
import type { LandedData } from '../workspaces/api.ts'
import type { Kind } from './refs.ts'

export type Notification = {
  kind: Kind
  title: string
  body: string
  path: string
  tag: string
  /** The conversation `path` opens, and the question it opens at. */
  conversation: number
  message?: number
}

/** A short plain-text preview, not the whole answer on the lock screen. */
export function firstLine(text: string) {
  return (
    text
      .replaceAll('**', '')
      .split('\n')
      .find((line) => line.trim()) ?? ''
  ).trim()
}
const body = (text: string) => (text.length > 180 ? `${text.slice(0, 179)}…` : text)

/** Questions from any local conversation; one-way news only from @ultimate. */
export function messageNotification(
  message: Pick<Message, 'id' | 'from' | 'to' | 'reply' | 'text' | 'questions'>,
  ultimate: number | undefined,
  title?: string,
): Notification | undefined {
  if (message.to !== 'user' || typeof message.from !== 'number') return undefined
  if (!message.reply && message.from !== ultimate) return undefined
  return {
    conversation: message.from,
    ...(message.reply ? { message: message.id } : {}),
    kind: message.reply ? 'input' : 'finished',
    title: message.from === ultimate ? 'Ultimate' : title || `#${message.from}`,
    body: body(message.questions?.[0]?.text ?? firstLine(message.text)),
    path: `/?conversation=${message.from}`,
    tag: `message:${message.id}`,
  }
}

export function landingNotification(
  landing: Pick<LandedData, 'title' | 'conversationId' | 'sha'>,
): Notification {
  return {
    conversation: landing.conversationId,
    kind: 'landed',
    title: 'Landed',
    body: body(landing.title),
    path: `/?conversation=${landing.conversationId}`,
    tag: `landed:${landing.sha}`,
  }
}

/** Pi's overview is not a domain event: these are the same terminal-run rules as the sounds extension. */
export function rowNotification(
  row: OverviewRow | undefined,
  ultimate: number,
  answer: string,
): Notification | undefined {
  const path = `/?conversation=${ultimate}`
  if (row?.runState === 'error' && row.inputId !== undefined)
    return {
      conversation: ultimate,
      kind: 'failed',
      title: 'Ultimate',
      body: 'Stopped with an error.',
      path,
      tag: `failed:${row.inputId}`,
    }
  if (row?.runState === 'answered' && row.answerId !== undefined && !row.internalInput)
    return {
      conversation: ultimate,
      kind: 'finished',
      title: 'Ultimate',
      body: body(firstLine(answer)),
      path,
      tag: `finished:${row.answerId}`,
    }
  return undefined
}
