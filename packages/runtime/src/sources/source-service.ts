import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { CopilotProvider } from '../providers/copilot'
import {
  sourceInputSchema,
  sourceSchema,
  protocolSchema,
  reasoningEffortSchema,
  type AvailableModel,
  type Credentials,
  type Source,
  type SourceInput,
} from '../contracts'

export type SourceFetch = (url: string, init?: RequestInit) => Promise<Response>

export function normalizeBaseUrl(value: string, kind: Source['kind']): string {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('Sources require HTTPS; HTTP is allowed only on loopback.')
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      'Source URLs must not contain credentials, queries, or fragments.',
    )
  url.pathname = url.pathname.replace(/\/+$/u, '')
  if (kind === 'remote') {
    if (url.pathname !== '/' && url.pathname !== '/v1')
      throw new Error(
        'Enter a remote ModelBridge root URL, optionally ending in /v1.',
      )
    url.pathname = '/v1'
  }
  return url.toString().replace(/\/+$/u, '')
}

export function sourceHeaders(
  source: Pick<Source, 'kind'>,
  protocol: SourceInput['protocol'],
  key: string,
): Headers {
  const headers = new Headers({
    Accept: 'application/json',
    'Content-Type': 'application/json',
  })
  if (source.kind === 'api' && protocol === 'messages') {
    headers.set('x-api-key', key)
    headers.set('anthropic-version', '2023-06-01')
  } else headers.set('Authorization', `Bearer ${key}`)
  return headers
}

const discoverySchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(512),
        name: z.string().optional(),
        modelbridge: z
          .object({
            protocol: protocolSchema,
            upstreamProtocol: protocolSchema.optional(),
            reasoningEfforts: z.array(reasoningEffortSchema).optional(),
            supportsTools: z.boolean().optional(),
            contextWindow: z
              .number()
              .int()
              .positive()
              .max(2_000_000)
              .optional(),
          })
          .optional(),
      }),
    )
    .min(1),
})

export async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      size += value.byteLength
      if (size > maxBytes)
        throw new Error(`Source response exceeds the ${maxBytes}-byte limit.`)
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}

export class SourceService {
  private sources: Source[]
  readonly copilot: CopilotProvider

  constructor(
    initial: Source[],
    readonly credentials: Credentials,
    private readonly persist: (sources: Source[]) => void,
    readonly fetcher: SourceFetch = fetch,
    copilot?: CopilotProvider,
  ) {
    this.copilot = copilot ?? new CopilotProvider(credentials, fetcher)
    this.sources = z.array(sourceSchema).parse(initial)
    if (
      new Set(this.sources.map((source) => source.id)).size
      !== this.sources.length
    )
      throw new Error('Saved source identities must be unique.')
    for (const source of this.sources) {
      if (normalizeBaseUrl(source.baseUrl, source.kind) !== source.baseUrl)
        throw new Error(
          'Saved source URLs must be normalized and valid for their source type.',
        )
      if (
        new Set(source.models.map((model) => model.id)).size
        !== source.models.length
      )
        throw new Error(
          'Saved model identities must be unique within each source.',
        )
    }
  }

  list(): Source[] {
    return structuredClone(this.sources)
  }

  setShared(id: string, shared: boolean): void {
    if (!this.sources.some((source) => source.id === id))
      throw new Error('The selected source does not exist.')
    const next = this.sources.map((source) =>
      source.id === id ? { ...source, shared } : source,
    )
    this.persist(next)
    this.sources = next
  }

  models(sharedOnly = false): AvailableModel[] {
    return this.sources
      .filter((source) => !sharedOnly || source.shared)
      .flatMap((source) =>
        source.models.map((model) => ({
          id: `${source.id}/${model.id}`,
          name: model.name,
          sourceId: source.id,
          sourceLabel: source.label,
          protocol: model.protocol,
          upstreamProtocol: model.upstreamProtocol,
          reasoningEfforts: model.reasoningEfforts,
          supportsTools: model.supportsTools,
          contextWindow: model.contextWindow,
        })),
      )
  }

  resolve(id: string, sharedOnly = false) {
    for (const source of this.sources) {
      if (sharedOnly && !source.shared) continue
      const model = source.models.find(
        (candidate) => `${source.id}/${candidate.id}` === id,
      )
      if (model) return { source, model }
    }
    return null
  }

  async add(value: SourceInput): Promise<Source> {
    const input = sourceInputSchema.parse(value)
    const baseUrl = normalizeBaseUrl(input.baseUrl, input.kind)
    let response: Response
    try {
      response = await this.fetcher(`${baseUrl}/models`, {
        headers: sourceHeaders(input, input.protocol, input.apiKey),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      throw new Error(
        'Source discovery failed. Check the endpoint, network, and tunnel access.',
        { cause: error },
      )
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(
        `Source discovery returned HTTP ${response.status}. Check its credentials and availability.`,
      )
    }
    const catalogText = await readBoundedText(response, 4 * 1024 * 1024)
    let catalog: z.infer<typeof discoverySchema>
    try {
      catalog = discoverySchema.parse(JSON.parse(catalogText))
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError)
        throw new Error(
          'Source discovery returned an invalid JSON model catalog.',
          { cause: error },
        )
      throw error
    }
    if (
      new Set(catalog.data.map((model) => model.id)).size
      !== catalog.data.length
    )
      throw new Error('Source discovery returned duplicate model identities.')
    const source: Source = {
      id: randomUUID(),
      label: input.label,
      kind: input.kind,
      baseUrl,
      shared: input.shared,
      models: catalog.data.map((model) => {
        if (input.kind === 'remote' && !model.modelbridge)
          throw new Error(
            'The remote endpoint does not advertise ModelBridge capabilities.',
          )
        return {
          id: model.id,
          name: model.name || model.id,
          protocol: model.modelbridge?.protocol ?? input.protocol,
          upstreamProtocol: model.modelbridge?.upstreamProtocol,
          reasoningEfforts: model.modelbridge?.reasoningEfforts,
          supportsTools: model.modelbridge?.supportsTools,
          contextWindow: model.modelbridge?.contextWindow,
        }
      }),
    }
    this.credentials.set(source.id, input.apiKey)
    const next = [...this.sources, source]
    try {
      this.persist(next)
    } catch (error) {
      this.credentials.remove(source.id)
      throw error
    }
    this.sources = next
    return structuredClone(source)
  }

  async addCopilot(
    githubToken: string,
    label: string,
    shared: boolean,
    signal?: AbortSignal,
  ): Promise<Source> {
    const catalog = await this.copilot.discover(githubToken, signal)
    signal?.throwIfAborted()
    const source = sourceSchema.parse({
      id: randomUUID(),
      kind: 'copilot',
      label,
      shared,
      ...catalog,
    })
    this.credentials.set(source.id, githubToken)
    try {
      this.persist([...this.sources, source])
    } catch (error) {
      this.credentials.remove(source.id)
      throw error
    }
    this.sources.push(source)
    return structuredClone(source)
  }

  async refresh(id: string): Promise<void> {
    const existing = this.sources.find((source) => source.id === id)
    if (!existing) throw new Error('The selected source does not exist.')
    let replacement: Source
    if (existing.kind === 'copilot') {
      replacement = sourceSchema.parse({
        ...existing,
        ...(await this.copilot.refresh(id)),
      })
    } else {
      let discovered: Source | undefined
      const temporary = new SourceService(
        [],
        {
          get: () => this.credentials.get(id),
          set: () => {},
          remove: () => {},
        },
        (next) => {
          discovered = next[0]
        },
        this.fetcher,
      )
      await temporary.add({
        label: existing.label,
        shared: existing.shared,
        baseUrl: existing.baseUrl,
        kind: existing.kind,
        protocol: existing.models[0].protocol,
        apiKey: this.credentials.get(id),
      })
      if (!discovered)
        throw new Error('Source refresh did not return a catalog.')
      replacement = { ...discovered, id }
    }
    const next = this.sources.map((source) =>
      source.id === id ?
        { ...source, models: replacement.models, baseUrl: replacement.baseUrl }
      : source,
    )
    this.persist(next)
    this.sources = next
  }
}
