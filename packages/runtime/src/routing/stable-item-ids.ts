// Copilot encrypts every Responses stream item id with a fresh nonce, so one
// item arrives under a different id in each event. Clients that key items by
// id (such as the Codex desktop app) then render a message twice: once from
// its streamed text and again from its completed item. Every event for an
// output index therefore reuses the id from that index's first event.
import { rewriteSseJson } from './sse-lines'

type Json = Record<string, unknown>

const terminalTypes = new Set([
  'response.completed',
  'response.incomplete',
  'response.failed',
])

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stabilize(event: Json, ids: Map<number, string>): boolean {
  let changed = false
  const index = event.output_index
  if (typeof index === 'number') {
    const holder =
      isRecord(event.item) && typeof event.item.id === 'string' ? event.item
      : typeof event.item_id === 'string' ? event
      : undefined
    const key = holder === event ? 'item_id' : 'id'
    const id = holder?.[key]
    if (holder && typeof id === 'string') {
      const stable = ids.get(index)
      if (stable === undefined) ids.set(index, id)
      else if (stable !== id) {
        holder[key] = stable
        changed = true
      }
    }
  }
  if (
    typeof event.type === 'string'
    && terminalTypes.has(event.type)
    && isRecord(event.response)
    && Array.isArray(event.response.output)
  ) {
    for (const [position, item] of event.response.output.entries()) {
      const stable = ids.get(position)
      if (
        stable !== undefined
        && isRecord(item)
        && typeof item.id === 'string'
        && item.id !== stable
      ) {
        item.id = stable
        changed = true
      }
    }
  }
  return changed
}

export function stabilizeResponseItemIds(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const ids = new Map<number, string>()
  return rewriteSseJson(body, (event) =>
    stabilize(event, ids) ? 'changed' : 'unchanged',
  )
}
