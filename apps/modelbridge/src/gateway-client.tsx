import { useEffect, useRef, useState } from 'react'
import type { AvailableModel, Protocol } from '@modelbridge/runtime/contracts'
import { protocolPaths } from './apps'
import {
  createStreamParser,
  parseErrorBody,
  parseReply,
  probeRequest,
  type ParsedReply,
} from './chat-protocol'
import type { PlaygroundRequest, PlaygroundResult, Result } from './types'

export interface Sent {
  result: PlaygroundResult
  body: string
}

// Sends a request through the local gateway and streams the reply text.
export async function send(
  path: PlaygroundRequest['path'],
  body?: Record<string, unknown>,
  onText?: (text: string) => void,
  onStart?: (id: string) => void,
): Promise<Sent> {
  const id = crypto.randomUUID()
  let text = ''
  const stop = window.modelbridge.onPlaygroundChunk((chunk) => {
    if (chunk.id !== id) return
    text += chunk.text
    onText?.(chunk.text)
  })
  onStart?.(id)
  try {
    const result = await window.modelbridge.playgroundSend({
      id,
      path,
      ...(body && { body }),
    })
    if (!result.ok) throw new Error(result.error)
    return { result: result.value, body: text }
  } finally {
    stop()
  }
}

export function CopyButton({
  copy,
  label = 'Copy',
  className,
}: {
  copy: () => Promise<Result<void>>
  label?: string
  className?: string
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <button
      type="button"
      className={className ?? 'copy'}
      onClick={() => {
        void copy()
          .then((result) => setState(result.ok ? 'copied' : 'failed'))
          .catch(() => setState('failed'))
          .finally(() => {
            clearTimeout(timer.current)
            timer.current = setTimeout(() => setState('idle'), 2000)
          })
      }}
    >
      <span aria-live="polite">
        {state === 'copied' ?
          'Copied'
        : state === 'failed' ?
          'Copy failed'
        : label}
      </span>
    </button>
  )
}

export const copyText = (text: string) => () =>
  window.modelbridge.copyText(text)

export interface ProbeResult {
  ok: boolean
  durationMs: number
  detail: string
}

// Sends the cheapest request that proves the model answers on a protocol.
export async function probe(
  protocol: Protocol,
  model: Pick<AvailableModel, 'id' | 'reasoningEfforts'>,
): Promise<ProbeResult> {
  const request = probeRequest(protocol, model)
  const started = performance.now()
  try {
    const { result, body } = await send(protocolPaths[protocol], request.body)
    const durationMs = result.durationMs || performance.now() - started
    if (result.status >= 400)
      return {
        ok: false,
        durationMs,
        detail: `HTTP ${result.status}: ${parseErrorBody(body, result.status)}`,
      }
    let reply: ParsedReply
    if (result.contentType.includes('text/event-stream')) {
      const parser = createStreamParser(protocol)
      parser.push(body)
      reply = parser.finish()
    } else {
      try {
        reply = parseReply(protocol, JSON.parse(body))
      } catch {
        reply = { text: '', reasoning: '', error: 'The reply was not JSON.' }
      }
    }
    if (reply.error) return { ok: false, durationMs, detail: reply.error }
    const text = reply.text.trim()
    return {
      ok: true,
      durationMs,
      detail:
        text ? `Replied “${text.slice(0, 60)}”`
        : reply.reasoning ? 'Answered (reasoning only, no visible text)'
        : 'Answered with an empty reply',
    }
  } catch (reason) {
    return {
      ok: false,
      durationMs: performance.now() - started,
      detail: reason instanceof Error ? reason.message : String(reason),
    }
  }
}
