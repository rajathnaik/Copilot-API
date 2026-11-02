import { z } from 'zod'

export const protocolSchema = z.enum([
  'responses',
  'messages',
  'chat-completions',
])
export type Protocol = z.infer<typeof protocolSchema>
export const reasoningEffortSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])

const tokenLimitSchema = z.number().int().positive().max(2_000_000)
export const modelCapabilitiesSchema = z.object({
  upstreamProtocol: protocolSchema.optional(),
  reasoningEfforts: z.array(reasoningEffortSchema).optional(),
  supportsTools: z.boolean().optional(),
  supportsParallelToolCalls: z.boolean().optional(),
  inputModalities: z
    .array(z.enum(['text', 'image']))
    .min(1)
    .optional(),
  contextWindow: tokenLimitSchema.optional(),
  maxOutputTokens: tokenLimitSchema.optional(),
  maxImageBytes: z.number().int().positive().optional(),
})
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>

// Copies only advertised capabilities so routing metadata never leaks into them.
export function modelCapabilities(model: ModelCapabilities): ModelCapabilities {
  return {
    upstreamProtocol: model.upstreamProtocol,
    reasoningEfforts: model.reasoningEfforts,
    supportsTools: model.supportsTools,
    supportsParallelToolCalls: model.supportsParallelToolCalls,
    inputModalities: model.inputModalities,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    maxImageBytes: model.maxImageBytes,
  }
}

export const modelSchema = z
  .object({
    id: z.string().trim().min(1).max(512),
    name: z.string().min(1),
    protocol: protocolSchema,
    ...modelCapabilitiesSchema.shape,
  })
  .strict()

const sharedModelIdsSchema = z
  .array(modelSchema.shape.id)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    'Shared model identities must be unique.',
  )

export const sourceSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string().trim().min(1).max(100),
    kind: z.enum(['api', 'remote', 'copilot']),
    baseUrl: z.string().url(),
    shared: z.boolean(),
    sharedModelIds: sharedModelIdsSchema.optional(),
    webSearchModelId: z.string().trim().min(1).max(512).optional(),
    models: z.array(modelSchema).min(1),
  })
  .strict()
export type Source = z.infer<typeof sourceSchema>

export const sourceInputSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    kind: z.enum(['api', 'remote']),
    baseUrl: z.string().url(),
    protocol: protocolSchema,
    apiKey: z.string().trim().min(1).max(8192).regex(/^\S+$/u),
    shared: z.boolean(),
  })
  .strict()
export type SourceInput = z.infer<typeof sourceInputSchema>
export const sharingInputSchema = z
  .object({
    sourceId: z.string().uuid(),
    shared: z.boolean(),
    sharedModelIds: sharedModelIdsSchema.nullable().optional(),
  })
  .strict()
export const copilotInputSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    shared: z.boolean(),
  })
  .strict()

export interface AvailableModel extends ModelCapabilities {
  id: string
  name: string
  sourceId: string
  sourceLabel: string
  protocol: Protocol
}

export function webSearchCandidates(source: Pick<Source, 'models'>) {
  return source.models.filter(
    (model) =>
      model.upstreamProtocol === 'responses' && model.supportsTools !== false,
  )
}

// Picks the model that runs proxied web searches for Messages-backed models.
// Auto prefers the newest full-size GPT model; mini, nano and codex variants
// are used only when nothing else exists.
export function webSearchModel(
  source: Pick<Source, 'models' | 'webSearchModelId'>,
) {
  const candidates = webSearchCandidates(source)
  const chosen = candidates.find(
    (model) => model.id === source.webSearchModelId,
  )
  if (chosen) return chosen
  const rank = (id: string) => {
    const version = /^gpt-(\d+)(?:\.(\d+))?/iu.exec(id)
    return {
      variant: /mini|nano|codex/iu.test(id) ? 1 : 0,
      version:
        version ? Number(version[1]) * 1000 + Number(version[2] ?? 0) : 0,
    }
  }
  return candidates
    .filter((model) => /^gpt-/iu.test(model.id))
    .sort((left, right) => {
      const a = rank(left.id)
      const b = rank(right.id)
      return (
        a.variant - b.variant
        || b.version - a.version
        || left.id.localeCompare(right.id)
      )
    })[0]
}

export interface Credentials {
  get(id: string): string
  set(id: string, value: string): void | Promise<void>
  remove(id: string): void | Promise<void>
}

export const stateSchema = z
  .object({
    version: z.literal(1),
    tunnelId: z.string().regex(/^modelbridge-[a-f0-9]{32}$/u),
    sources: z.array(sourceSchema),
  })
  .strict()
export type ApplicationState = z.infer<typeof stateSchema>
