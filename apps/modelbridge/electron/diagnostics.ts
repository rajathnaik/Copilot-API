import fs from 'node:fs'
import path from 'node:path'

export interface DiagnosticsLog {
  readonly file: string
  write(event: string, detail?: string): Promise<void>
}

export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'Unknown error'
  const parts = [`${error.name}: ${error.message}`]
  // Fetch failures hide the useful part (DNS, TLS, timeout) in their causes.
  let cause: unknown = error.cause
  for (let depth = 0; depth < 4 && cause; depth++) {
    if (!(cause instanceof Error)) break
    const code = (cause as { code?: unknown }).code
    parts.push(
      `cause ${cause.name}${typeof code === 'string' || typeof code === 'number' ? `[${code}]` : ''}: ${cause.message}`,
    )
    cause = cause.cause
  }
  return parts.join(' <- ')
}

/**
 * Appends non-secret startup and responsiveness events without blocking the
 * main thread. Callers must never pass keys, tokens, or request content.
 */
export function createDiagnosticsLog(
  directory: string,
  elapsed: () => number = () => performance.now(),
  limit = 512 * 1024,
): DiagnosticsLog {
  const file = path.join(directory, 'logs', 'modelbridge.log')
  let chain: Promise<void> = fs.promises
    .mkdir(path.dirname(file), { recursive: true })
    .then(async () => {
      const stat = await fs.promises.stat(file).catch(() => null)
      if (stat && stat.size > limit) await fs.promises.rename(file, `${file}.1`)
    })
    .catch(() => undefined)
  return {
    file,
    write(event, detail) {
      const suffix =
        detail ? ` ${detail.replace(/\s+/gu, ' ').slice(0, 500)}` : ''
      const line = `${new Date().toISOString()} +${Math.round(elapsed())}ms ${event}${suffix}\n`
      chain = chain
        .then(() => fs.promises.appendFile(file, line, 'utf8'))
        .catch(() => undefined)
      return chain
    },
  }
}
