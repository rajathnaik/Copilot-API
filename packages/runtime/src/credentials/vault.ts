import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Credentials } from '../contracts'

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

const storeSchema = z.record(z.string(), z.string().min(1))

/**
 * Plain JSON credential store inside the user's profile. Keys are not
 * encrypted at rest; protection relies on the Windows user account.
 */
export class CredentialStore implements Credentials {
  private constructor(
    private readonly file: string,
    private values: Record<string, string>,
  ) {}

  static open(file: string): CredentialStore {
    const saved = readOptional(file)
    return new CredentialStore(
      file,
      saved === null ? {} : storeSchema.parse(JSON.parse(saved)),
    )
  }

  get(id: string): string {
    const value = this.values[id]
    if (!value) throw new Error('No saved credential exists for this source.')
    return value
  }

  set(id: string, value: string): void {
    this.setMany({ [id]: value })
  }

  setMany(entries: Record<string, string>): void {
    if (Object.values(entries).some((value) => !value.trim()))
      throw new Error('A nonempty credential is required.')
    this.write({ ...this.values, ...entries })
  }

  remove(id: string): void {
    const next = { ...this.values }
    delete next[id]
    this.write(next)
  }

  private write(next: Record<string, string>): void {
    atomicWrite(this.file, JSON.stringify(next))
    this.values = next
  }
}
