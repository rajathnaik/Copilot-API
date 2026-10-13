import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AvailableModel, Credentials } from '../contracts'
import { atomicWrite, readOptional } from '../credentials/vault'
import { createCodexCatalog, codexDefaultReasoning } from './codex-catalog'
import {
  configureCodex,
  configValue,
  hasManagedProvider,
  hash,
  managedFingerprint,
  redactConfig,
  restoreCodex,
} from './codex-config'

const revisionSchema = z.object({
  id: z.string().uuid(),
  label: z.string().min(1),
  model: z.string(),
  createdAt: z.string(),
  catalog: z.string(),
  content: z.string(),
  action: z.enum(['configure', 'restore']),
})
const savedSchema = z.object({
  original: z.string().nullable(),
  active: z.string().nullable(),
  fingerprint: z.string(),
  revisions: z.array(revisionSchema),
  pending: z
    .object({
      before: z.string().nullable(),
      after: z.string(),
      revisionId: z.string(),
    })
    .nullable(),
})
export interface CodexPreview {
  id: string
  label: string
  configPath: string
  catalogPath: string
  before: string
  after: string
  changes: string[]
}
export interface CodexConfigurationStatus {
  configPath: string
  effective: { provider: string; model: string }
  active: string | null
  externalManagedEdit: boolean
  revisions: Array<{
    id: string
    label: string
    model: string
    createdAt: string
    action: 'configure' | 'restore'
  }>
}

export class CodexConfigurations {
  private saved: z.infer<typeof savedSchema> | null = null
  private readonly previews = new Map<
    string,
    {
      preview: CodexPreview
      before: string | null
      content: string
      revision: z.infer<typeof revisionSchema>
    }
  >()
  private readonly vaultId: string

  constructor(
    readonly configPath: string,
    private readonly directory: string,
    private readonly credentials: Credentials,
    private readonly helper: { command: string; args: string[] },
  ) {
    this.vaultId = `codex-configurations-${hash(configPath)}`
    const marker = path.join(directory, `${hash(configPath)}.managed`)
    if (fs.existsSync(marker)) {
      this.saved = savedSchema.parse(JSON.parse(credentials.get(this.vaultId)))
      if (this.saved.pending) {
        const pending = this.saved.pending
        const current = readOptional(configPath)
        if (current === pending.after) {
          const revision = this.saved.revisions.find(
            (item) => item.id === pending.revisionId,
          )
          if (!revision)
            throw new Error(
              'Codex configuration recovery is missing its revision.',
            )
          this.saved.active = revision.action === 'restore' ? null : revision.id
          this.saved.fingerprint = managedFingerprint(pending.after)
        } else if (current !== pending.before)
          throw new Error(
            'An interrupted Codex configuration change conflicts with an external edit. Preserve both profiles for recovery.',
          )
        this.saved.pending = null
        this.persist(this.saved)
      }
    }
  }

  private persist(next: z.infer<typeof savedSchema>) {
    this.credentials.set(this.vaultId, JSON.stringify(savedSchema.parse(next)))
    atomicWrite(
      path.join(this.directory, `${hash(this.configPath)}.managed`),
      'ModelBridge manages revisions for this Codex configuration.',
    )
    this.saved = next
  }

  status(): CodexConfigurationStatus {
    const current = readOptional(this.configPath) ?? ''
    const value = configValue(current)
    return {
      configPath: this.configPath,
      effective: {
        provider:
          typeof value.model_provider === 'string' ?
            value.model_provider
          : 'openai (default)',
        model: typeof value.model === 'string' ? value.model : 'Codex default',
      },
      active: this.saved?.active ?? null,
      externalManagedEdit:
        !!this.saved && managedFingerprint(current) !== this.saved.fingerprint,
      revisions: (this.saved?.revisions ?? []).map(
        ({ id, label, model, createdAt, action }) => ({
          id,
          label,
          model,
          createdAt,
          action,
        }),
      ),
    }
  }

  private prepare(
    label: string,
    content: string,
    catalog: string,
    model: string,
    action: 'configure' | 'restore',
  ): CodexPreview {
    if (this.saved?.pending)
      throw new Error(
        'A previous Codex change needs recovery. Restart ModelBridge before editing.',
      )
    const before = readOptional(this.configPath)
    if (
      this.saved
      && managedFingerprint(before ?? '') !== this.saved.fingerprint
    )
      throw new Error(
        'Codex provider/model settings were changed outside ModelBridge. Review the current settings before explicitly reconciling them.',
      )
    if (!this.saved && hasManagedProvider(before ?? ''))
      throw new Error(
        'The modelbridge provider already exists but is not owned by this installation. Choose another Codex profile or remove that provider yourself after review.',
      )
    const id = randomUUID()
    const catalogPath = path.join(this.directory, `${id}.models.json`)
    const revision = revisionSchema.parse({
      id,
      label,
      model,
      createdAt: new Date().toISOString(),
      catalog,
      content,
      action,
    })
    const preview = {
      id,
      label,
      configPath: this.configPath,
      catalogPath,
      before: redactConfig(before ?? ''),
      after: redactConfig(content),
      changes:
        action === 'restore' ?
          [
            'Restore the original provider/model/catalog/reasoning settings.',
            'Preserve current unrelated settings and native auth.json/keychain.',
          ]
        : [
            'model_provider selects the independent modelbridge provider, not the ChatGPT backend.',
            'model selects the exact source-qualified gateway model; no subscription or billing fallback.',
            'model_catalog_json supplies Codex-native picker metadata, not OpenAI /models JSON.',
            'base_url points to the local ModelBridge gateway, which routes to the remote host URL/key.',
            'auth.command asks this same installed app for its OS-protected local key. No secret is written to TOML.',
            'requires_openai_auth=false keeps custom-provider requests independent of native ChatGPT sign-in.',
            'Unrelated settings and native auth.json/keychain remain unchanged. Restart Codex and open a new local chat.',
          ],
    }
    this.previews.clear()
    this.previews.set(id, { preview, before, content, revision })
    return preview
  }

  preview(
    label: string,
    modelId: string,
    models: AvailableModel[],
    url: string,
  ): CodexPreview {
    const validLabel = z.string().trim().min(1).max(100).parse(label)
    const model = models.find((item) => item.id === modelId)
    if (!model || model.protocol !== 'responses')
      throw new Error(
        'Choose an available Responses-compatible model for Codex.',
      )
    const catalog = JSON.stringify(createCodexCatalog(models))
    if (Buffer.byteLength(catalog) > 1024 * 1024)
      throw new Error('Codex catalog exceeds its 1 MiB client limit.')
    const id = randomUUID()
    const content = configureCodex(readOptional(this.configPath) ?? '', {
      model: model.id,
      url,
      catalogPath: path.join(this.directory, `${id}.models.json`),
      helperCommand: this.helper.command,
      helperArgs: this.helper.args,
      reasoningEffort: codexDefaultReasoning(model),
    })
    const preview = this.prepare(
      validLabel,
      content,
      catalog,
      model.id,
      'configure',
    )
    const prepared = this.previews.get(preview.id)
    if (!prepared) throw new Error('Codex preview could not be created.')
    prepared.preview.catalogPath = path.join(
      this.directory,
      `${id}.models.json`,
    )
    return prepared.preview
  }

  restore(): CodexPreview {
    if (!this.saved)
      throw new Error(
        'No original Codex configuration has been saved by this installation.',
      )
    return this.prepare(
      'Restore native Codex',
      restoreCodex(
        readOptional(this.configPath) ?? '',
        this.saved.original ?? '',
      ),
      '',
      '',
      'restore',
    )
  }

  previewRevision(
    id: string,
    models: AvailableModel[],
    url: string,
  ): CodexPreview {
    const revision = this.saved?.revisions.find((item) => item.id === id)
    if (!revision)
      throw new Error('The selected Codex revision does not exist.')
    return revision.action === 'restore' ?
        this.restore()
      : this.preview(revision.label, revision.model, models, url)
  }

  reconcile(): CodexConfigurationStatus {
    if (!this.saved || this.saved.pending)
      throw new Error(
        'No committed Codex configuration is available to reconcile.',
      )
    const current = readOptional(this.configPath) ?? ''
    const next = {
      ...this.saved,
      fingerprint: managedFingerprint(current),
      active: null,
    }
    this.persist(next)
    return this.status()
  }

  apply(id: string): CodexConfigurationStatus {
    const operation = this.previews.get(id)
    if (!operation)
      throw new Error(
        'The Codex preview is stale. Generate a new preview before applying.',
      )
    if (hash(readOptional(this.configPath)) !== hash(operation.before))
      throw new Error(
        'Codex configuration changed after the preview. Nothing was overwritten; generate a fresh preview.',
      )
    const { revision, content } = operation
    if (revision.action === 'configure')
      atomicWrite(operation.preview.catalogPath, revision.catalog)
    const next = {
      original: this.saved ? this.saved.original : operation.before,
      active: this.saved?.active ?? null,
      fingerprint:
        this.saved?.fingerprint ?? managedFingerprint(operation.before ?? ''),
      revisions: [...(this.saved?.revisions ?? []), revision],
      pending: {
        before: operation.before,
        after: content,
        revisionId: revision.id,
      },
    }
    this.persist(next)
    atomicWrite(this.configPath, content)
    this.persist({
      ...next,
      active: revision.action === 'restore' ? null : revision.id,
      fingerprint: managedFingerprint(content),
      pending: null,
    })
    this.previews.clear()
    return this.status()
  }
}
