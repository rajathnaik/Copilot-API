import { record, list, text, type Json } from '../../adapters/json'
import { stripModelBridgeThinking } from '../../adapters/anthropic-messages'
import { resolveSupportedReasoningEffort } from './reasoning-effort'
import { toMessagesInputSchema } from './tool-schema'

const combinators = ['anyOf', 'oneOf', 'allOf'] as const

// Claude models reject tool schemas with a top-level combinator, including
// when Copilot serves them on its Chat Completions endpoint.
function flattenSchema(schema: unknown): unknown {
  const value = record(schema)
  if (!value || !combinators.some((key) => key in value)) return schema
  return toMessagesInputSchema(value)
}

export function nativeChatPayload(
  body: Json,
  efforts: string[] | undefined,
): { payload: Json; usage: boolean } {
  const payload: Json = { ...body }
  delete payload.service_tier
  const options = record(payload.stream_options)
  const usage = options?.include_usage === true
  if (payload.stream === true)
    payload.stream_options = { ...options, include_usage: true }
  const effort = text(payload.reasoning_effort)
  if (effort) {
    const resolved = resolveSupportedReasoningEffort(effort, efforts)
    if (resolved) payload.reasoning_effort = resolved
  }
  const tools = list(payload.tools)
  if (tools)
    payload.tools = tools.map((value) => {
      const tool = record(value)
      const fn = record(tool?.function)
      if (!tool || !fn || !('parameters' in fn)) return value
      return {
        ...tool,
        function: { ...fn, parameters: flattenSchema(fn.parameters) },
      }
    })
  return { payload, usage }
}

export function nativeMessagesPayload(body: Json): Json {
  const payload = stripModelBridgeThinking({ ...body })
  const tools = list(payload.tools)
  if (tools)
    payload.tools = tools.map((value) => {
      const tool = record(value)
      if (!tool || !('input_schema' in tool)) return value
      return { ...tool, input_schema: flattenSchema(tool.input_schema) }
    })
  return payload
}

// Copilot charges premium requests for user turns only; tool results and
// assistant continuations are agent turns.
export function nativeInitiatorIsAgent(
  protocol: 'chat-completions' | 'messages',
  payload: Json,
): boolean {
  const last = record(list(payload.messages)?.at(-1))
  if (!last || last.role !== 'user') return true
  if (protocol === 'chat-completions') return false
  const content = list(last.content)
  return (
    !!content?.length
    && content.every((block) => record(block)?.type === 'tool_result')
  )
}
