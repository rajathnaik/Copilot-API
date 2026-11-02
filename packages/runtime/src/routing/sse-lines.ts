export type SseJson = Record<string, unknown>
export type SseRewrite = 'unchanged' | 'changed' | 'drop'

function isRecord(value: unknown): value is SseJson {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rewriteLine(
  line: string,
  rewrite: (event: SseJson) => SseRewrite,
): string | null {
  const carriage = line.endsWith('\r') ? '\r' : ''
  const content = carriage ? line.slice(0, -1) : line
  if (!content.startsWith('data:')) return line
  const data = content.slice(5).trimStart()
  if (!data.startsWith('{')) return line
  let event: unknown
  try {
    event = JSON.parse(data)
  } catch {
    return line
  }
  if (!isRecord(event)) return line
  const outcome = rewrite(event)
  if (outcome === 'drop') return null
  if (outcome === 'unchanged') return line
  return `data: ${JSON.stringify(event)}${carriage}`
}

// Rewrites the JSON `data:` lines of an event stream one line at a time.
// Other lines and unchanged events pass through byte for byte; a dropped
// event leaves only its blank separator, which clients ignore.
export function rewriteSseJson(
  body: ReadableStream<Uint8Array>,
  rewrite: (event: SseJson) => SseRewrite,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ''
  const write = (lines: string[]) =>
    lines
      .map((line) => rewriteLine(line, rewrite))
      .filter((line): line is string => line !== null)
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true })
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        const output = write(lines)
        if (output.length)
          controller.enqueue(encoder.encode(output.join('\n') + '\n'))
      },
      flush(controller) {
        pending += decoder.decode()
        if (!pending) return
        const [line] = write([pending])
        if (line !== undefined) controller.enqueue(encoder.encode(line))
      },
    }),
  )
}
