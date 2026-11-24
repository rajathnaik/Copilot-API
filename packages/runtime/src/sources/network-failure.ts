export type NetworkFailureKind =
  | 'timeout'
  | 'dns'
  | 'refused'
  | 'connect-timeout'
  | 'reset'
  | 'tls'
  | 'redirect'
  | 'cancelled'
  | 'other'

export interface NetworkFailure {
  kind: NetworkFailureKind
  // Lower-case phrase that completes "…failed: <reason>".
  reason: string
}

function chain(error: unknown) {
  const links: Array<{ name: string; code: string; message: string }> = []
  // Node reports refused connections as an AggregateError of per-address errors.
  const queue: unknown[] = [error]
  while (queue.length && links.length < 12) {
    const current = queue.shift()
    if (!current || typeof current !== 'object') continue
    const value = current as {
      name?: unknown
      code?: unknown
      message?: unknown
      cause?: unknown
      errors?: unknown
    }
    links.push({
      name: typeof value.name === 'string' ? value.name : '',
      code:
        typeof value.code === 'string' || typeof value.code === 'number' ?
          String(value.code)
        : '',
      message: typeof value.message === 'string' ? value.message : '',
    })
    queue.push(value.cause)
    if (Array.isArray(value.errors)) queue.push(...(value.errors as unknown[]))
  }
  return links
}

/**
 * I classify fetch exceptions by their cause chain (Node, Bun and Chromium
 * spell these differently) so a client sees why a host is unreachable
 * instead of a generic "failed".
 */
export function classifyNetworkFailure(error: unknown): NetworkFailure {
  const links = chain(error)
  const codes = links.map((link) => link.code).filter(Boolean)
  const text = links
    .map((link) => `${link.name} ${link.code} ${link.message}`)
    .join(' ')
  const code = codes.at(-1)
  const has = (pattern: RegExp) => pattern.test(text)
  if (has(/redirect/iu))
    return {
      kind: 'redirect',
      reason: 'the endpoint answered with a redirect',
    }
  if (has(/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|DNS|getaddrinfo/iu))
    return {
      kind: 'dns',
      reason: 'the host name could not be resolved (DNS)',
    }
  if (has(/ECONNREFUSED|ConnectionRefused|ERR_CONNECTION_REFUSED/iu))
    return { kind: 'refused', reason: 'the connection was refused' }
  if (
    has(
      /UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ERR_CONNECTION_TIMED_OUT|ConnectTimeout/iu,
    )
  )
    return {
      kind: 'connect-timeout',
      reason: 'a connection could not be opened in time',
    }
  if (
    has(
      /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|ERR_BAD_SSL|REVOCATION/iu,
    )
  )
    return {
      kind: 'tls',
      reason: `the secure connection failed${code ? ` (${code})` : ''}`,
    }
  if (
    has(
      /ECONNRESET|EPIPE|UND_ERR_SOCKET|ERR_CONNECTION_(RESET|CLOSED|ABORTED)|ConnectionClosed|socket hang up|other side closed/iu,
    )
  )
    return { kind: 'reset', reason: 'the connection was closed unexpectedly' }
  if (links.some((link) => link.name === 'TimeoutError') || has(/timed out/iu))
    return { kind: 'timeout', reason: 'the endpoint did not respond in time' }
  if (links.some((link) => link.name === 'AbortError'))
    return { kind: 'cancelled', reason: 'the request was cancelled' }
  return {
    kind: 'other',
    reason: code ? `network error (${code})` : 'network error',
  }
}
