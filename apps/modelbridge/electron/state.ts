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
  private constructor(
    private readonly file: string,
    public value: ApplicationState,
    readonly vault: EncryptedVault,
  ) {}

  static async open(
    directory: string,
    codec: CredentialCodec,
  ): Promise<AppState> {
    const file = path.join(directory, 'state.json')
    const saved = readOptional(file)
    const vaultFile = path.join(directory, 'credentials.encrypted.json')
    if (saved === null && readOptional(vaultFile) !== null)
      throw new Error(
        'ModelBridge metadata is missing but protected credentials remain. Preserve the profile; do not silently reset its keys.',
      )
    const value =
      saved === null ?
        {
          version: 1 as const,
          tunnelId: `modelbridge-${randomUUID().replaceAll('-', '')}`,
          sources: [],
        }
      : stateSchema.parse(JSON.parse(saved))
    const vault = await EncryptedVault.open(vaultFile, codec)
    const state = new AppState(file, value, vault)
    if (saved === null) {
      await vault.setMany({
        'local-access': randomBytes(32).toString('hex'),
        'remote-access': randomBytes(32).toString('hex'),
      })
      state.save(value)
    }
    for (const id of ['local-access', 'remote-access']) vault.get(id)
    for (const source of value.sources) vault.get(source.id)
    return state
  }

  save(value: ApplicationState): void {
    const validated = stateSchema.parse(value)
    atomicWrite(this.file, JSON.stringify(validated))
    this.value = validated
  }
}
