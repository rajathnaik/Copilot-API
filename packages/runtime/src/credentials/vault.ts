import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Credentials } from '../contracts'

export interface CredentialCodec {
  encrypt(value: string): string
  decrypt(value: string): string
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
    fs.renameSync(temporary, file)
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

export class EncryptedVault implements Credentials {
  private values: Record<string, string>

  constructor(
    private readonly file: string,
    private readonly codec: CredentialCodec,
  ) {
    const saved = readOptional(file)
    this.values = saved === null ? {} : vaultSchema.parse(JSON.parse(saved))
  }

  get(id: string): string {
    const encrypted = this.values[id]
    if (!encrypted)
      throw new Error('No saved credential exists for this source.')
    try {
      const value = this.codec.decrypt(encrypted)
      if (!value.trim()) throw new Error('The decrypted credential is empty.')
      return value
    } catch (error) {
      throw new Error(
        'ModelBridge cannot decrypt this credential in the current OS profile. Preserve or restore the protected profile; use a fresh isolated profile for a new setup. Saved keys were not replaced.',
        { cause: error },
      )
    }
  }

  set(id: string, value: string): void {
    if (!value.trim()) throw new Error('A nonempty credential is required.')
    const next = { ...this.values, [id]: this.codec.encrypt(value) }
    atomicWrite(this.file, JSON.stringify(next))
    this.values = next
  }

  remove(id: string): void {
    const next = { ...this.values }
    delete next[id]
    atomicWrite(this.file, JSON.stringify(next))
    this.values = next
  }
}
