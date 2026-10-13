import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  stateSchema,
  type ApplicationState,
} from '@modelbridge/runtime/contracts'
import {
  atomicWrite,
  readOptional,
  EncryptedVault,
  type CredentialCodec,
} from '@modelbridge/runtime/credentials'

export class AppState {
  private readonly file: string
  value: ApplicationState
  readonly vault: EncryptedVault

  constructor(directory: string, codec: CredentialCodec) {
    this.file = path.join(directory, 'state.json')
    const saved = readOptional(this.file)
    const vaultFile = path.join(directory, 'credentials.encrypted.json')
    if (saved === null && readOptional(vaultFile) !== null)
      throw new Error(
        'ModelBridge metadata is missing but protected credentials remain. Preserve the profile; do not silently reset its keys.',
      )
    this.value =
      saved === null ?
        {
          version: 1,
          tunnelId: `modelbridge-${randomUUID().replaceAll('-', '')}`,
          sources: [],
        }
      : stateSchema.parse(JSON.parse(saved))
    this.vault = new EncryptedVault(vaultFile, codec)
    for (const id of ['local-access', 'remote-access']) {
      if (saved === null) this.vault.set(id, randomBytes(32).toString('hex'))
      else this.vault.get(id)
    }
    for (const source of this.value.sources) this.vault.get(source.id)
    if (saved === null) this.save(this.value)
  }

  save(value: ApplicationState): void {
    const validated = stateSchema.parse(value)
    atomicWrite(this.file, JSON.stringify(validated))
    this.value = validated
  }
}
