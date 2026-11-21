import type { ResponseInputItem } from './responses'
import type { AnthropicMessagesPayload } from './anthropic'

import {
  COMPACTION_REPLAY_PROMPT,
  decodeMessagesCompaction,
} from './messages-translation'
import {
  decodeReasoningSignature,
  lastUserMessageIndex,
} from './reasoning-signature'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Makes a conversation that other model families contributed to acceptable to
 * Copilot's native Responses endpoint: their reasoning cannot be decrypted,
 * proxied web searches carry non-`ws` IDs, and Messages compactions are plain
 * summaries that must be replayed as text.
 */
export function prepareNativeResponsesInput(
  input: Array<ResponseInputItem>,
  options: { dropEarlierReasoning?: boolean } = {},
): { input: Array<ResponseInputItem>; changed: boolean } {
  const lastUser = lastUserMessageIndex(input)
  let changed = false
  const output: Array<ResponseInputItem> = []
  for (const [index, item] of input.entries()) {
    if (!isRecord(item)) {
      output.push(item)
      continue
    }
    if (item.type === 'reasoning') {
      if (
        decodeReasoningSignature(item.encrypted_content)
        || (options.dropEarlierReasoning && index < lastUser)
      ) {
        changed = true
        continue
      }
      if ('status' in item) {
        const { status: _status, ...rest } = item
        output.push(rest as ResponseInputItem)
        changed = true
        continue
      }
    }
    if (
      item.type === 'web_search_call'
      && typeof item.id === 'string'
      && !item.id.startsWith('ws')
    ) {
      const { id: _id, ...rest } = item
      output.push(rest as ResponseInputItem)
      changed = true
      continue
    }
    if (
      item.type === 'compaction'
      && typeof item.encrypted_content === 'string'
    ) {
      const summary = decodeMessagesCompaction(item.encrypted_content)
      if (summary) {
        output.push({
          type: 'message',
          role: 'user',
          content: `${COMPACTION_REPLAY_PROMPT}${summary}`,
        } as ResponseInputItem)
        changed = true
        continue
      }
    }
    output.push(item as ResponseInputItem)
  }
  return { input: changed ? output : input, changed }
}

/**
 * Returns the payload without replayed thinking, or undefined when it has
 * none. I use it to retry once when Claude rejects a thinking signature I
 * could not foresee: Claude continues a conversation, even mid tool loop,
 * without its earlier thinking, but never with a block it cannot verify.
 */
export function withoutReplayedThinking(
  payload: AnthropicMessagesPayload,
): AnthropicMessagesPayload | undefined {
  let changed = false
  const messages = payload.messages.flatMap((message) => {
    if (message.role !== 'assistant' || typeof message.content === 'string')
      return [message]
    const content = message.content.filter((block) => block.type !== 'thinking')
    if (content.length === message.content.length) return [message]
    changed = true
    return content.length ? [{ ...message, content }] : []
  })
  return changed ? { ...payload, messages } : undefined
}
