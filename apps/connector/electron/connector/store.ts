import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeFileAtomically } from '@copilot-api/shared/atomic-file'
import type {
  ConnectorConnection,
  ConnectorHarness,
} from '../../src/types/connector'
import { HARNESS_PROTOCOLS } from '../../src/types/connector'

export interface CredentialCodec {
  available(): boolean
  encrypt(value: string): string
  decrypt(value: string): string
}

export interface ConnectionState {
  version: 1
  connection: ConnectorConnection
  originalConfig: string | null
  fingerprint: string
}

type FileId = 'config' | 'catalog' | 'credential' | 'state'
type Changes = Partial<Record<FileId, string | null>>
interface Snapshot {
  id: FileId
  before: string | null
  after: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isFileId(value: unknown): value is FileId {
  return (
    value === 'config'
    || value === 'catalog'
    || value === 'credential'
    || value === 'state'
  )
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null
    throw error
  }
}

function parseStoredJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(
      `The connector ${label} is not valid JSON. Preserve it and restore it from a backup.`,
      { cause: error },
    )
  }
}

export class ConnectorStore {
  readonly files: Record<FileId, string>
  private readonly journalPath: string
  private readonly lockPath: string

  constructor(
    readonly directory: string,
    configPath: string,
    readonly codec: CredentialCodec,
    readonly harness: ConnectorHarness = 'codex',
  ) {
    this.files = {
      config: configPath,
      catalog: path.join(
        directory,
        harness === 'codex' ? 'codex-models.json' : 'models.json',
      ),
      credential: path.join(directory, 'gateway-key.encrypted'),
      state: path.join(directory, 'connection.json'),
    }
    this.journalPath = path.join(directory, 'transaction.json')
    this.lockPath = path.join(directory, 'setup.lock')
  }

  read(id: FileId): string | null {
    return readText(this.files[id])
  }

  state(): ConnectionState | null {
    const text = this.read('state')
    if (text === null) return null
    const value = parseStoredJson(text, 'state')
    if (
      !isRecord(value)
      || value.version !== 1
      || !nullableString(value.originalConfig)
      || typeof value.fingerprint !== 'string'
      || !/^[a-f0-9]{64}$/u.test(value.fingerprint)
      || !isRecord(value.connection)
    )
      throw new Error(
        'The saved connector state is invalid. Restore it from a backup before continuing.',
      )
    const connection = value.connection
    if (
      connection.harness !== this.harness
      || typeof connection.baseUrl !== 'string'
      || typeof connection.model !== 'string'
      || typeof connection.modelCount !== 'number'
      || (connection.catalogMode !== 'remote'
        && connection.catalogMode !== 'local'
        && connection.catalogMode !== 'configured')
      || (this.harness === 'codex' ?
        connection.catalogMode === 'configured'
      : connection.catalogMode !== 'configured')
      || typeof connection.verifiedAt !== 'string'
      || connection.configPath !== this.files.config
      || (connection.protocol !== undefined
        && connection.protocol !== 'responses'
        && connection.protocol !== 'anthropic-messages'
        && connection.protocol !== 'chat-completions')
      || (connection.protocol !== undefined
        && connection.protocol !== HARNESS_PROTOCOLS[this.harness])
      || (connection.credentialMode !== undefined
        && connection.credentialMode !== 'helper'
        && connection.credentialMode !== 'config')
      || (connection.credentialMode !== undefined
        && connection.credentialMode
          !== (this.harness === 'opencode' ? 'config' : 'helper'))
    )
      throw new Error(
        `The saved connection belongs to a different or invalid ${this.harness} configuration. Restore its configuration home or undo it in its original environment.`,
      )
    return {
      version: 1,
      originalConfig: value.originalConfig,
      fingerprint: value.fingerprint,
      connection: {
        harness: this.harness,
        baseUrl: connection.baseUrl,
        model: connection.model,
        modelCount: connection.modelCount,
        catalogMode: connection.catalogMode,
        verifiedAt: connection.verifiedAt,
        configPath: this.files.config,
        ...(connection.protocol === undefined ?
          {}
        : {
            protocol: connection.protocol,
          }),
        ...(connection.credentialMode === undefined ?
          {}
        : {
            credentialMode: connection.credentialMode,
          }),
      },
    }
  }

  key(): string {
    if (!this.codec.available()) {
      throw new Error(
        'OS-protected credential storage is unavailable. Enable your system keychain; plaintext storage is not supported.',
      )
    }
    const encrypted = this.read('credential')
    if (encrypted === null)
      throw new Error(
        'No saved gateway credential. Connect again with your API key.',
      )
    try {
      return this.codec.decrypt(encrypted)
    } catch (error) {
      throw new Error(
        'The saved gateway key cannot be decrypted in this OS user/profile. Open Copilot API Connector and reconnect with your gateway URL and API key. Keep the connector installed under the same OS account; do not delete your harness configuration.',
        { cause: error },
      )
    }
  }

  async revealKey(): Promise<string> {
    return this.exclusive(() => {
      if (!this.state())
        throw new Error('There is no saved connection to reveal a key for.')
      return Promise.resolve(this.key())
    })
  }

  backupConfig(content: string): void {
    const directory = path.join(this.directory, 'config-backups')
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    const timestamp = new Date().toISOString().replace(/[:.]/gu, '-')
    writeFileAtomically(
      path.join(
        directory,
        `${timestamp}-${randomUUID()}-${path.basename(this.files.config)}`,
      ),
      content,
    )
  }

  encryptKey(key: string): string {
    if (!this.codec.available()) {
      throw new Error(
        'OS-protected credential storage is unavailable. Enable your system keychain; plaintext storage is not supported.',
      )
    }
    return this.codec.encrypt(key)
  }

  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    let lock: number
    try {
      lock = fs.openSync(this.lockPath, 'wx', 0o600)
    } catch (error) {
      if (
        error instanceof Error
        && 'code' in error
        && error.code === 'EEXIST'
      ) {
        const owner = readText(this.lockPath)
        const pid = owner === null ? NaN : Number(owner)
        let stale = false
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0)
          } catch (probeError) {
            if (
              probeError instanceof Error
              && 'code' in probeError
              && probeError.code === 'ESRCH'
            )
              stale = true
            else throw probeError
          }
        }
        if (!stale || readText(this.lockPath) !== owner) {
          throw new Error(
            `Another connector operation is active. If a previous process crashed and its lock cannot be identified, close the connector and remove only ${this.lockPath}, then reopen to recover.`,
          )
        }
        fs.unlinkSync(this.lockPath)
        lock = fs.openSync(this.lockPath, 'wx', 0o600)
      } else {
        throw error
      }
    }
    try {
      fs.writeFileSync(lock, String(process.pid))
      fs.fsyncSync(lock)
      this.recover()
      return await operation()
    } finally {
      fs.closeSync(lock)
      fs.unlinkSync(this.lockPath)
    }
  }

  private replace(
    id: FileId,
    expected: string | null,
    content: string | null,
  ): void {
    if (this.read(id) !== expected) {
      throw new Error(
        `Concurrent changes detected in ${this.files[id]}. No external edits will be overwritten.`,
      )
    }
    if (content === null) {
      if (expected !== null) fs.unlinkSync(this.files[id])
    } else {
      writeFileAtomically(this.files[id], content)
    }
  }

  recover(): void {
    const text = readText(this.journalPath)
    if (text === null) return
    const value = parseStoredJson(text, 'recovery journal')
    if (
      !isRecord(value)
      || value.version !== 1
      || value.configPath !== this.files.config
      || !Array.isArray(value.snapshots)
    ) {
      throw new Error(
        'The connector recovery journal is invalid. Preserve it and restore the saved configuration manually.',
      )
    }
    const snapshots: Snapshot[] = []
    for (const snapshot of value.snapshots) {
      if (
        !isRecord(snapshot)
        || !isFileId(snapshot.id)
        || !nullableString(snapshot.before)
        || !nullableString(snapshot.after)
      ) {
        throw new Error(
          'The connector recovery journal has invalid file snapshots.',
        )
      }
      if (snapshots.some((item) => item.id === snapshot.id))
        throw new Error(
          'The recovery journal contains duplicate file snapshots.',
        )
      snapshots.push({
        id: snapshot.id,
        before: snapshot.before,
        after: snapshot.after,
      })
    }
    // Validate every file before restoring any, so an external edit does not
    // cause partial recovery or loss of the saved credential.
    for (const snapshot of snapshots) {
      const current = this.read(snapshot.id)
      if (current !== snapshot.before && current !== snapshot.after) {
        throw new Error(
          `Recovery stopped because ${this.files[snapshot.id]} was edited externally. The recovery journal was retained at ${this.journalPath}.`,
        )
      }
    }
    for (const snapshot of [...snapshots].reverse()) {
      const current = this.read(snapshot.id)
      if (current === snapshot.after && current !== snapshot.before) {
        this.replace(snapshot.id, current, snapshot.before)
      }
    }
    fs.unlinkSync(this.journalPath)
  }

  async transaction(
    changes: Changes,
    verify: () => Promise<string | void>,
    expectedConfig?: string | null,
  ): Promise<void> {
    const snapshots: Snapshot[] = []
    for (const id of ['config', 'catalog', 'credential', 'state'] as const) {
      if (id in changes) {
        const before = this.read(id)
        if (
          id === 'config'
          && expectedConfig !== undefined
          && before !== expectedConfig
        )
          throw new Error(
            'Harness configuration changed before setup. Close its editor and retry; no external edits were overwritten.',
          )
        snapshots.push({
          id,
          before,
          after: changes[id] ?? null,
        })
      }
    }
    const saveJournal = () =>
      writeFileAtomically(
        this.journalPath,
        JSON.stringify({
          version: 1,
          configPath: this.files.config,
          snapshots,
        }),
      )
    saveJournal()
    try {
      for (const snapshot of snapshots) {
        if (snapshot.id !== 'state')
          this.replace(snapshot.id, snapshot.before, snapshot.after)
      }
      const verifiedState = await verify()
      if (typeof verifiedState === 'string') {
        const state = snapshots.find((snapshot) => snapshot.id === 'state')
        if (!state)
          throw new Error('A verified connection requires a state snapshot.')
        state.after = verifiedState
        saveJournal()
      }
      for (const snapshot of snapshots) {
        if (snapshot.id === 'state')
          this.replace(snapshot.id, snapshot.before, snapshot.after)
        else if (this.read(snapshot.id) !== snapshot.after) {
          throw new Error(
            `Configuration changed during verification: ${this.files[snapshot.id]}.`,
          )
        }
      }
      fs.unlinkSync(this.journalPath)
    } catch (error) {
      try {
        this.recover()
      } catch (recoveryError) {
        const detail =
          recoveryError instanceof Error ?
            recoveryError.message
          : 'Recovery failed.'
        throw new Error(
          `Setup failed and automatic rollback could not finish. ${detail}`,
          { cause: error },
        )
      }
      throw error
    }
  }
}
