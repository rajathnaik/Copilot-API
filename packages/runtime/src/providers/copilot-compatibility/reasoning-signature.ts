// Reasoning that ModelBridge translates from Messages or Chat Completions
// carries its model family, so a later request only replays it to a model that
// can verify it. Native Responses reasoning is left untouched.
const REASONING_PREFIX = 'modelbridge:reasoning:v1:'

export function reasoningFamily(model: string): string {
  const bare = model.slice(model.lastIndexOf('/') + 1).toLowerCase()
  return /^[a-z]+/u.exec(bare)?.[0] ?? bare
}

export function encodeReasoningSignature(
  family: string,
  signature: string,
): string {
  if (!signature) return ''
  return Buffer.from(
    `${REASONING_PREFIX}${family}:${signature}`,
    'utf8',
  ).toString('base64')
}

export function decodeReasoningSignature(
  value: unknown,
): { family: string; signature: string } | null {
  if (typeof value !== 'string' || !value) return null
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) return null
  const text = decoded.toString('utf8')
  if (!text.startsWith(REASONING_PREFIX)) return null
  const rest = text.slice(REASONING_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator <= 0) return null
  return {
    family: rest.slice(0, separator),
    signature: rest.slice(separator + 1),
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function lastUserMessageIndex(input: Array<unknown>): number {
  for (let index = input.length - 1; index >= 0; index--) {
    const item = input[index]
    if (
      isRecord(item)
      && (item.type === undefined || item.type === 'message')
      && item.role === 'user'
    )
      return index
  }
  return -1
}
