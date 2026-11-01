import fs from 'node:fs'
import path from 'node:path'

export interface DiagnosticsLog {
  readonly file: string
  write(event: string, detail?: string): Promise<void>
}

export function describeError(error: unknown): string {
  return error instanceof Error ?
      `${error.name}: ${error.message}`
    : 'Unknown error'
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
