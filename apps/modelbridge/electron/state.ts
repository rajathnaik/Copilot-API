import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  stateSchema,
  type ApplicationState,
} from '@modelbridge/runtime/contracts'
import {
  atomicWrite,
  readOptional,
  CredentialStore,
} from '@modelbridge/runtime/credentials'

export const credentialsFile = 'credentials.json'
const legacyCredentialsFile = 'credentials.encrypted.json'

/**
 * Earlier builds encrypted credentials; they cannot be read without that
 * machinery. Archive them, keep the tunnel identity, and drop sources whose
 * credentials were lost so the user only has to sign in again.
 */
function archiveLegacyProfile(directory: string): string | null {
  const legacy = path.join(directory, legacyCredentialsFile)
  if (
    !fs.existsSync(legacy)
    || fs.existsSync(path.join(directory, credentialsFile))
  )
    return null
  const archive = path.join(
    directory,
    `legacy-encrypted-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`,
  )
  fs.mkdirSync(archive, { recursive: true })
  for (const name of [legacyCredentialsFile, 'state.json', 'codex']) {
    const from = path.join(directory, name)
    if (fs.existsSync(from))
      fs.cpSync(from, path.join(archive, name), { recursive: true })
  }
  const saved = readOptional(path.join(directory, 'state.json'))
  if (saved !== null) {
    const state = stateSchema.parse(JSON.parse(saved))
    atomicWrite(
      path.join(directory, 'state.json'),
      JSON.stringify({ ...state, sources: [] }),
    )
  }
  fs.rmSync(path.join(directory, 'codex'), { recursive: true, force: true })
  fs.rmSync(legacy)
  return archive
}

export class AppState {
  private constructor(
    private readonly file: string,
    public value: ApplicationState,
    readonly vault: CredentialStore,
    readonly archivedLegacyProfile: string | null,
  ) {}

  static open(directory: string): AppState {
    const archived = archiveLegacyProfile(directory)
    const file = path.join(directory, 'state.json')
    const saved = readOptional(file)
    const storeFile = path.join(directory, credentialsFile)
    if (saved === null && readOptional(storeFile) !== null)
      throw new Error(
        'ModelBridge metadata is missing but saved credentials remain. Preserve the profile; do not silently reset its keys.',
      )
    const value =
      saved === null ?
        {
          version: 1 as const,
          tunnelId: `modelbridge-${randomUUID().replaceAll('-', '')}`,
          sources: [],
        }
      : stateSchema.parse(JSON.parse(saved))
    const vault = CredentialStore.open(storeFile)
    const state = new AppState(file, value, vault, archived)
    const missing = ['local-access', 'remote-access'].filter((id) => {
      try {
        vault.get(id)
        return false
      } catch {
        return true
      }
    })
    if (missing.length > 0)
      vault.setMany(
        Object.fromEntries(
          missing.map((id) => [id, randomBytes(32).toString('hex')]),
        ),
      )
    if (saved === null) state.save(value)
    return state
  }

  save(value: ApplicationState): void {
    const validated = stateSchema.parse(value)
    atomicWrite(this.file, JSON.stringify(validated))
    this.value = validated
  }
}
