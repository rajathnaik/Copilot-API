import { events } from 'fetch-event-stream'
import { z } from 'zod'
import type {
  AnthropicStreamEventData,
  AnthropicStreamState,
} from './anthropic'
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
} from './chat-completions'
import { translateToAnthropic } from './chat-translation'
import {
  flushPendingAnthropicStreamEvents,
  translateChunkToAnthropicEvents,
} from './chat-stream-translation'
import { ResponsesMessagesTranslationError } from './messages-translation'

export function decodeChatResponse(value: unknown) {
  const response = z
    .custom<ChatCompletionResponse>(
      (item: unknown) =>
        !!item
        && typeof item === 'object'
        && 'id' in item
        && typeof item.id === 'string'
        && 'choices' in item
        && Array.isArray(item.choices),
    )
    .safeParse(value)
  if (!response.success)
    throw new ResponsesMessagesTranslationError(
      'Copilot returned an invalid Chat Completions response.',
      502,
    )
  return translateToAnthropic(response.data)
}

export async function* chatAsMessages(response: Response) {
  const state: AnthropicStreamState = {
    messageStartSent: false,
    messageCompleted: false,
    contentBlockIndex: 0,
    contentBlockOpen: false,
    thinkingBlockOpen: false,
    toolCalls: {},
  }
  let finished = false
  const encode = (item: AnthropicStreamEventData) => ({
    event: item.type,
    data: JSON.stringify(item),
  })
  for await (const event of events(response)) {
    if (!event.data || event.data === '[DONE]') continue
    const chunk = z
      .custom<ChatCompletionChunk>(
        (item: unknown) =>
          !!item
          && typeof item === 'object'
          && 'id' in item
          && typeof item.id === 'string'
          && 'choices' in item
          && Array.isArray(item.choices),
      )
      .parse(JSON.parse(event.data))
    if (
      chunk.choices.some((choice) => typeof choice.finish_reason === 'string')
    )
      finished = true
    for (const message of translateChunkToAnthropicEvents(chunk, state))
      yield encode(message)
  }
  if (!finished)
    throw new ResponsesMessagesTranslationError(
      'Chat Completions stream ended without a finish reason.',
      502,
    )
  for (const message of flushPendingAnthropicStreamEvents(state))
    yield encode(message)
}
