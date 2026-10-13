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

export const modelSchema = z
  .object({
    id: z.string().trim().min(1).max(512),
    name: z.string().min(1),
    protocol: protocolSchema,
    upstreamProtocol: protocolSchema.optional(),
    reasoningEfforts: z.array(reasoningEffortSchema).optional(),
    supportsTools: z.boolean().optional(),
    contextWindow: z.number().int().positive().max(2_000_000).optional(),
  })
  .strict()

export const sourceSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string().trim().min(1).max(100),
    kind: z.enum(['api', 'remote', 'copilot']),
    baseUrl: z.string().url(),
    shared: z.boolean(),
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
  })
  .strict()
export const copilotInputSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    shared: z.boolean(),
  })
  .strict()

export interface AvailableModel {
  id: string
  name: string
  sourceId: string
  sourceLabel: string
  protocol: Protocol
  upstreamProtocol?: Protocol
  reasoningEfforts?: Array<z.infer<typeof reasoningEffortSchema>>
  supportsTools?: boolean
  contextWindow?: number
}

export interface Credentials {
  get(id: string): string
  set(id: string, value: string): void
  remove(id: string): void
}

export const stateSchema = z
  .object({
    version: z.literal(1),
    tunnelId: z.string().regex(/^modelbridge-[a-f0-9]{32}$/u),
    sources: z.array(sourceSchema),
  })
  .strict()
export type ApplicationState = z.infer<typeof stateSchema>
