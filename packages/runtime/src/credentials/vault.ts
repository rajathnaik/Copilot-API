import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Credentials } from '../contracts'

export interface CredentialCodec {
  encrypt(value: string): string | Promise<string>
  decrypt(value: string): string | Promise<string>
  /** Returns false when a stored record should be re-protected in the current format. */
  isCurrent?(encrypted: string): boolean
}

const transientLocks = new Set(['EPERM', 'EACCES', 'EBUSY'])

// Antivirus and indexers briefly lock freshly written files on Windows.
function rename(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error ? String(error.code) : ''
      if (
        process.platform !== 'win32'
        || attempt >= 10
        || !transientLocks.has(code)
      )
        throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
}

export function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, content, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    rename(temporary, file)
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
    throw error
  }
}

export function readOptional(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null
    throw error
  }
}

const vaultSchema = z.record(z.string(), z.string().min(1))

/**
 * Decrypts every record once when opened so reads never wait on the OS
 * credential provider. Writes are serialized to keep the file consistent.
 */
export class EncryptedVault implements Credentials {
  private readonly plain = new Map<string, string>()
  private readonly failures = new Map<string, unknown>()
  private queue: Promise<void> = Promise.resolve()

  private constructor(
    private readonly file: string,
    private readonly codec: CredentialCodec,
    private values: Record<string, string>,
  ) {}

  /**
   * Pass `only` to decrypt a subset; other records stay encrypted and any
   * `get` for them fails, which keeps least-privilege readers narrow.
   */
  static async open(
    file: string,
    codec: CredentialCodec,
    only?: readonly string[],
  ): Promise<EncryptedVault> {
    const saved = readOptional(file)
    const vault = new EncryptedVault(
      file,
      codec,
      saved === null ? {} : vaultSchema.parse(JSON.parse(saved)),
    )
    await Promise.all(
      Object.entries(vault.values)
        .filter(([id]) => !only || only.includes(id))
        .map(async ([id, encrypted]) => {
          try {
            const value = await codec.decrypt(encrypted)
            if (!value.trim())
              throw new Error('The decrypted credential is empty.')
            vault.plain.set(id, value)
          } catch (error) {
            vault.failures.set(id, error)
          }
        }),
    )
    return vault
  }

  get(id: string): string {
    const value = this.plain.get(id)
    if (value !== undefined) return value
    if (!this.values[id])
      throw new Error('No saved credential exists for this source.')
    throw new Error(
      'ModelBridge cannot decrypt this credential in the current OS profile. Preserve or restore the protected profile; use a fresh isolated profile for a new setup. Saved keys were not replaced.',
      { cause: this.failures.get(id) },
    )
  }

  set(id: string, value: string): Promise<void> {
    return this.setMany({ [id]: value })
  }

  setMany(entries: Record<string, string>): Promise<void> {
    if (Object.values(entries).some((value) => !value.trim()))
      return Promise.reject(new Error('A nonempty credential is required.'))
    return this.enqueue(async () => {
      const encrypted = await Promise.all(
        Object.entries(entries).map(
          async ([id, value]) => [id, await this.codec.encrypt(value)] as const,
        ),
      )
      const next = { ...this.values, ...Object.fromEntries(encrypted) }
      atomicWrite(this.file, JSON.stringify(next))
      this.values = next
      for (const [id, value] of Object.entries(entries)) {
        this.plain.set(id, value)
        this.failures.delete(id)
      }
    })
  }

  remove(id: string): Promise<void> {
    return this.enqueue(() => {
      const next = { ...this.values }
      delete next[id]
      atomicWrite(this.file, JSON.stringify(next))
      this.values = next
      this.plain.delete(id)
      this.failures.delete(id)
    })
  }

  /** Re-protects a readable record when the codec reports an older format. */
  async upgrade(id: string): Promise<boolean> {
    const encrypted = this.values[id]
    if (!encrypted || !this.codec.isCurrent || this.codec.isCurrent(encrypted))
      return false
    await this.set(id, this.get(id))
    return true
  }

  private enqueue(operation: () => void | Promise<void>): Promise<void> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => undefined)
    return result
  }
}
