import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { events } from 'fetch-event-stream'
import {
  findWebSearchTool,
  translateResponsesToMessages,
  translateAnthropicToResponses,
  ResponsesMessagesTranslationError,
  type ResponsesToMessagesTranslation,
} from './copilot-compatibility/messages-translation'
import { translateMessagesStream } from './copilot-compatibility/messages-stream-translation'
import { requestContext } from './copilot-compatibility/context'
import type { AnthropicResponse } from './copilot-compatibility/anthropic'
import type {
  ResponseInputItem,
  ResponseStreamEvent,
} from './copilot-compatibility/responses'
import { normalizeCopilotRequest } from './copilot-compatibility/request-normalization'
import {
  collectResponse,
  extractWebSearchResult,
  proxyWebSearch,
  WebSearchResultCache,
  type WebSearchOutcome,
  type WebSearchRound,
} from './copilot-compatibility/web-search-proxy'
import type { Credentials, Protocol, Source } from '../contracts'
import { reasoningEffortSchema, webSearchModel } from '../contracts'
import { resolveSupportedReasoningEffort } from './copilot-compatibility/reasoning-effort'
import { translateToOpenAI } from './copilot-compatibility/chat-translation'
import {
  chatAsMessages,
  decodeChatResponse,
} from './copilot-compatibility/chat-bridge'
import { readBoundedText, type SourceFetch } from '../sources/source-service'

// Direct protocol retained from the inherited Copilot API integration.
const clientId = 'Iv1.b507a08c87ecfe98'
const userAgent = 'GitHubCopilotChat/0.67.0'
const editorVersion = '1.139.1'
const deviceSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
})
const tokenSchema = z.object({
  token: z.string().min(1),
  refresh_in: z.number().positive(),
  expires_at: z.number().positive(),
  endpoints: z.object({ api: z.string().url().optional() }).optional(),
})
const catalogSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1).max(512),
        name: z.string().optional(),
        supported_endpoints: z.array(z.string()).optional(),
        policy: z.object({ state: z.string() }).optional(),
        capabilities: z
          .object({
            type: z.string().optional(),
            supports: z
              .object({
                tool_calls: z.boolean().optional(),
                parallel_tool_calls: z.boolean().optional(),
                vision: z.boolean().optional(),
                reasoning_effort: z.array(z.string()).optional(),
              })
              .optional(),
            limits: z
              .object({
                max_context_window_tokens: z
                  .number()
                  .int()
                  .positive()
                  .max(2_000_000)
                  .optional(),
                max_output_tokens: z
                  .number()
                  .int()
                  .positive()
                  .max(2_000_000)
                  .optional(),
                vision: z
                  .object({
                    max_prompt_image_size: z
                      .number()
                      .int()
                      .positive()
                      .optional(),
                  })
                  .passthrough()
                  .optional(),
              })
              .optional(),
          })
          .optional(),
      }),
    )
    .min(1),
})
type CopilotToken = z.infer<typeof tokenSchema> & {
  refreshAt: number
  api: string
}

export interface CopilotLogin {
  url: string
  code: string
  expiresAt: number
}

function apiUrl(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.search
    || url.hash
    || !(
      url.hostname === 'api.githubcopilot.com'
      || /^api\.(?:individual|business|enterprise)\.githubcopilot\.com$/u.test(
        url.hostname,
      )
    )
  )
    throw new Error(
      'Copilot token exchange returned an unexpected service endpoint. Credentials were not forwarded.',
    )
  if (url.pathname !== '/')
    throw new Error('Copilot service endpoint must not include a path.')
  return url.origin
}

export class CopilotProvider {
  private readonly tokens = new Map<string, CopilotToken>()
  private readonly refreshing = new Map<string, Promise<CopilotToken>>()
  private readonly deviceId = randomUUID()
  private readonly sessionId = randomUUID()
  private readonly searchResults: WebSearchResultCache

  constructor(
    private readonly credentials: Credentials,
    private readonly fetcher: SourceFetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly sleep: (
      ms: number,
      signal: AbortSignal,
    ) => Promise<void> = (ms, signal) =>
      new Promise((resolve, reject) => {
        signal.throwIfAborted()
        const abort = () => {
          clearTimeout(timer)
          const reason: unknown = signal.reason
          reject(
            reason instanceof Error ? reason : (
              new Error('Copilot operation was cancelled.')
            ),
          )
        }
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort)
          resolve()
        }, ms)
        signal.addEventListener('abort', abort, { once: true })
      }),
    private readonly requestTimeout = 120_000,
  ) {
    this.searchResults = new WebSearchResultCache(now)
  }

  private async json(url: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetcher(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.any([
        init.signal ?? new AbortController().signal,
        AbortSignal.timeout(30_000),
      ]),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(
        `Copilot returned HTTP ${response.status}. Check sign-in, subscription entitlement and network access.`,
      )
    }
    return JSON.parse(
      await readBoundedText(response, 4 * 1024 * 1024),
    ) as unknown
  }

  async beginLogin(signal: AbortSignal) {
    const device = deviceSchema.parse(
      await this.json('https://github.com/login/device/code', {
        method: 'POST',
        signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ client_id: clientId, scope: 'read:user' }),
      }),
    )
    if (device.verification_uri !== 'https://github.com/login/device')
      throw new Error('GitHub returned an unexpected sign-in URL.')
    const expiresAt = this.now() + device.expires_in * 1000
    return {
      login: {
        url: device.verification_uri,
        code: device.user_code,
        expiresAt,
      },
      complete: async () => {
        let interval = device.interval
        while (this.now() < expiresAt) {
          signal.throwIfAborted()
          await this.sleep((interval + 1) * 1000, signal)
          if (this.now() >= expiresAt) break
          const result = z
            .object({
              access_token: z.string().min(1).optional(),
              error: z.string().optional(),
              error_description: z.string().optional(),
              interval: z.number().positive().optional(),
            })
            .parse(
              await this.json('https://github.com/login/oauth/access_token', {
                method: 'POST',
                signal,
                headers: {
                  Accept: 'application/json',
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  client_id: clientId,
                  device_code: device.device_code,
                  grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                }),
              }),
            )
          if (result.access_token) return result.access_token
          if (result.error === 'slow_down')
            interval = Math.max(interval + 5, result.interval ?? 0)
          else if (result.error !== 'authorization_pending')
            throw new Error(
              `GitHub sign-in failed: ${result.error_description ?? result.error ?? 'No access token returned.'}`,
            )
        }
        throw new Error('GitHub sign-in expired. Start Copilot sign-in again.')
      },
    }
  }

  private async exchange(
    githubToken: string,
    signal?: AbortSignal,
  ): Promise<CopilotToken> {
    const token = tokenSchema.parse(
      await this.json('https://api.github.com/copilot_internal/v2/token', {
        signal,
        headers: {
          authorization: `token ${githubToken}`,
          'user-agent': userAgent,
          'x-github-api-version': '2025-04-01',
          'x-vscode-user-agent-library-version': 'electron-fetch',
        },
      }),
    )
    return {
      ...token,
      api: apiUrl(token.endpoints?.api ?? 'https://api.githubcopilot.com'),
      refreshAt: this.now() + Math.max(1000, token.refresh_in * 1000 - 60_000),
    }
  }

  private async token(id: string): Promise<CopilotToken> {
    const existing = this.tokens.get(id)
    if (
      existing
      && Math.min(existing.refreshAt, existing.expires_at * 1000 - 60_000)
        > this.now()
    )
      return existing
    const pending = this.refreshing.get(id)
    if (pending) return pending
    const operation = this.exchange(this.credentials.get(id)).then((value) => {
      this.tokens.set(id, value)
      return value
    })
    this.refreshing.set(id, operation)
    try {
      return await operation
    } finally {
      this.refreshing.delete(id)
    }
  }

  private headers(
    token: CopilotToken,
    discovery = false,
    conversation?: string,
  ): Headers {
    const requestId = randomUUID()
    return new Headers({
      Authorization: `Bearer ${token.token}`,
      'content-type': 'application/json',
      'copilot-integration-id': 'vscode-chat',
      'editor-device-id': this.deviceId,
      'editor-version': `vscode/${editorVersion}`,
      'editor-plugin-version': 'copilot-chat/0.67.0',
      'user-agent': userAgent,
      'openai-intent': 'conversation-agent',
      'x-github-api-version': '2026-08-01',
      'x-vscode-user-agent-library-version': 'electron-fetch',
      'x-request-id': requestId,
      'x-agent-task-id': conversation ?? requestId,
      'x-interaction-id': conversation ?? requestId,
      'x-interaction-type': discovery ? 'model-access' : 'conversation-agent',
      'vscode-sessionid': this.sessionId,
    })
  }

  private async catalog(token: CopilotToken, signal?: AbortSignal) {
    const catalog = catalogSchema.parse(
      await this.json(`${token.api}/models`, {
        headers: this.headers(token, true),
        signal,
      }),
    )
    const models: Source['models'] = []
    for (const model of catalog.data) {
      if (
        model.capabilities?.type === 'embeddings'
        || model.policy?.state === 'disabled'
      )
        continue
      const endpoints = model.supported_endpoints ?? ['/chat/completions']
      const protocol: Protocol | undefined =
        endpoints.some((item) => /(?:^|\/)responses$/u.test(item)) ? 'responses'
        : endpoints.some((item) => /(?:^|\/)messages$/u.test(item)) ? 'messages'
        : endpoints.some((item) => /chat\/completions$/u.test(item)) ?
          'chat-completions'
        : undefined
      if (!protocol) continue
      models.push({
        id: model.id,
        name: model.name || model.id,
        protocol: 'responses',
        upstreamProtocol: protocol,
        reasoningEfforts:
          model.capabilities?.supports?.reasoning_effort?.flatMap((value) => {
            const effort = reasoningEffortSchema.safeParse(value)
            return effort.success ? [effort.data] : []
          }),
        supportsTools: model.capabilities?.supports?.tool_calls,
        supportsParallelToolCalls:
          model.capabilities?.supports?.parallel_tool_calls,
        inputModalities:
          (
            model.capabilities?.supports?.vision
            || model.capabilities?.limits?.vision
          ) ?
            ['text', 'image']
          : ['text'],
        contextWindow: model.capabilities?.limits?.max_context_window_tokens,
        maxOutputTokens: model.capabilities?.limits?.max_output_tokens,
        maxImageBytes:
          model.capabilities?.limits?.vision?.max_prompt_image_size,
      })
    }
    if (!models.length)
      throw new Error(
        'Copilot discovery returned no enabled inference models with supported endpoints.',
      )
    if (new Set(models.map((model) => model.id)).size !== models.length)
      throw new Error('Copilot discovery returned duplicate model identities.')
    return { baseUrl: `${token.api}/v1`, models }
  }

  async discover(githubToken: string, signal?: AbortSignal) {
    return this.catalog(await this.exchange(githubToken, signal), signal)
  }

  async refresh(id: string) {
    this.tokens.delete(id)
    return this.catalog(await this.token(id))
  }

  // `signal` is the client's connection; each upstream request adds its own
  // deadline so multi-request web-search turns are not cut short.
  async forward(
    source: Source,
    protocol: Protocol,
    body: Record<string, unknown>,
    signal: AbortSignal,
    conversation?: string,
  ): Promise<Response> {
    const token = await this.token(source.id)
    const payload = { ...body }
    const model = source.models.find((item) => item.id === body.model)
    normalizeCopilotRequest(payload, model?.maxImageBytes)
    const input = payload.input
    const last: unknown = Array.isArray(input) ? input.at(-1) : undefined
    const initiator =
      last && typeof last === 'object' ?
        !('role' in last)
        || !last.role
        || (typeof last.role === 'string'
          && last.role.toLowerCase() === 'assistant')
      : false
    const reasoning = payload.reasoning
    if (
      reasoning
      && typeof reasoning === 'object'
      && 'effort' in reasoning
      && typeof reasoning.effort === 'string'
    ) {
      const effort = resolveSupportedReasoningEffort(
        reasoning.effort,
        model?.reasoningEfforts,
      )
      if (effort) payload.reasoning = { ...reasoning, effort }
    }
    delete payload.service_tier
    const endpoint =
      protocol === 'messages' ? '/v1/messages'
      : protocol === 'chat-completions' ? '/chat/completions'
      : '/responses'
    const vision = JSON.stringify(payload).includes('"input_image"')
    const send = (upstream: unknown, agent: boolean) => {
      const headers = this.headers(token, false, conversation)
      headers.set('x-initiator', agent ? 'agent' : 'user')
      if (vision) headers.set('copilot-vision-request', 'true')
      return this.fetcher(`${token.api}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(upstream),
        redirect: 'error',
        signal: this.deadline(signal),
      })
    }
    if (protocol === 'responses') {
      const response = await send(payload, initiator)
      return response.ok ? response : this.failure(source.id, token, response)
    }
    const translate = (value: Record<string, unknown>) =>
      requestContext.run({ sessionAffinity: conversation }, () => {
        z.object({
          model: z.string(),
          instructions: z.string().nullish(),
          input: z
            .union([z.string(), z.array(z.object({}).passthrough())])
            .optional(),
          tools: z
            .array(z.object({ type: z.string() }).passthrough())
            .nullish(),
          max_output_tokens: z.number().int().positive().nullish(),
          stream: z.boolean().nullish(),
        })
          .passthrough()
          .parse(value)
        const translation = translateResponsesToMessages(
          { ...value, model: z.string().parse(value.model) },
          {
            model: z.string().parse(value.model),
            webSearchResult: (id) => this.searchResults.get(id),
          },
        )
        const chat =
          protocol === 'chat-completions' ?
            translateToOpenAI(translation.messagesPayload, {
              validateReasoningEffort: !!model?.reasoningEfforts?.length,
              reasoningEffortSupport: model?.reasoningEfforts,
            })
          : null
        if (chat && value.stream) chat.stream_options = { include_usage: true }
        return { translation, chat }
      })
    const first = translate(payload)
    if (findWebSearchTool(first.translation.registry))
      return this.forwardWithWebSearch(source, token, payload, signal, {
        initiator,
        translate,
        send,
      })
    const { translation, chat } = first
    const response = await send(chat ?? translation.messagesPayload, initiator)
    if (!response.ok) return this.failure(source.id, token, response)
    if (!payload.stream) {
      const decoded: unknown = JSON.parse(
        await readBoundedText(response, 8 * 1024 * 1024),
      )
      if (chat)
        return Response.json(
          translateAnthropicToResponses(
            decodeChatResponse(decoded),
            translation,
          ),
        )
      const body = z
        .custom<AnthropicResponse>((value: unknown) => {
          if (!value || typeof value !== 'object') return false
          return (
            'id' in value
            && typeof value.id === 'string'
            && 'content' in value
            && Array.isArray(value.content)
            && 'type' in value
            && value.type === 'message'
            && 'usage' in value
            && typeof value.usage === 'object'
          )
        })
        .safeParse(decoded)
      if (!body.success)
        throw new ResponsesMessagesTranslationError(
          'Copilot returned an invalid Messages response.',
          502,
        )
      return Response.json(
        translateAnthropicToResponses(body.data, translation),
      )
    }
    return eventStream(
      translateMessagesStream(
        chat ? chatAsMessages(response) : events(response),
        translation,
      ),
    )
  }

  // Messages and chat models cannot use Copilot's hosted web search, so
  // ModelBridge exposes it as a function tool and answers each call with a
  // GPT Responses search before continuing the turn.
  private async forwardWithWebSearch(
    source: Source,
    token: CopilotToken,
    payload: Record<string, unknown>,
    signal: AbortSignal,
    upstream: {
      initiator: boolean
      translate: (value: Record<string, unknown>) => {
        translation: ResponsesToMessagesTranslation
        chat: Record<string, unknown> | null
      }
      send: (body: unknown, agent: boolean) => Promise<Response>
    },
  ): Promise<Response> {
    const input: Array<ResponseInputItem> =
      typeof payload.input === 'string' ?
        [{ type: 'message', role: 'user', content: payload.input }]
      : Array.isArray(payload.input) ?
        (payload.input as Array<ResponseInputItem>)
      : []
    const round = async (items: Array<ResponseInputItem>, agent: boolean) => {
      const { translation, chat } = upstream.translate({
        ...payload,
        input: items,
        stream: true,
      })
      const response = await upstream.send(
        chat ?? translation.messagesPayload,
        agent,
      )
      return { response, translation, chat }
    }
    const rounds = ({
      response,
      translation,
      chat,
    }: Awaited<ReturnType<typeof round>>): WebSearchRound => ({
      events: translateMessagesStream(
        chat ? chatAsMessages(response) : events(response),
        translation,
      ),
      registry: translation.registry,
    })
    const first = await round(input, upstream.initiator)
    if (!first.response.ok)
      return this.failure(source.id, token, first.response)
    const stream = proxyWebSearch(rounds(first), {
      input,
      next: async (items) => {
        const next = await round(items, true)
        if (next.response.ok) return rounds(next)
        if (next.response.status === 401) this.tokens.delete(source.id)
        await next.response.body?.cancel()
        throw new Error(
          `Copilot returned HTTP ${next.response.status} while continuing after web search.`,
        )
      },
      search: (query) => this.webSearch(source, token, query, signal),
      remember: (id, text) => this.searchResults.set(id, text),
    })
    if (payload.stream) return eventStream(stream)
    const collected = await collectResponse(stream)
    if (collected.ok && collected.result) return Response.json(collected.result)
    return Response.json(
      {
        error: {
          type: 'web_search_failed',
          message:
            collected.message
            ?? 'Copilot failed to complete the web search turn.',
        },
      },
      { status: 502 },
    )
  }

  private async webSearch(
    source: Source,
    token: CopilotToken,
    query: string,
    signal: AbortSignal,
  ): Promise<WebSearchOutcome> {
    const failed = (text: string): WebSearchOutcome => ({
      failed: true,
      text,
      sources: [],
    })
    const model = webSearchModel(source)
    if (!model)
      return failed(
        'Web search is unavailable because this Copilot subscription has no GPT Responses model with tool support.',
      )
    const effort =
      model.reasoningEfforts?.length ?
        resolveSupportedReasoningEffort('low', model.reasoningEfforts)
      : undefined
    const headers = this.headers(token, false)
    headers.set('x-initiator', 'agent')
    const deadline = this.deadline(signal)
    try {
      const response = await this.fetcher(`${token.api}/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model.id,
          instructions:
            'Search the web for the query and answer concisely with the facts found. Cite every source you used.',
          input: query,
          tools: [{ type: 'web_search', search_context_size: 'low' }],
          include: ['web_search_call.action.sources'],
          stream: true,
          store: false,
          ...(effort && { reasoning: { effort } }),
        }),
        redirect: 'error',
        signal: deadline,
      })
      if (!response.ok) {
        if (response.status === 401) this.tokens.delete(source.id)
        await response.body?.cancel()
        return failed(
          `Web search failed because Copilot returned HTTP ${response.status} for ${model.id}.`,
        )
      }
      const items: Array<unknown> = []
      let completed: { output?: unknown; output_text?: unknown } | undefined
      for await (const message of events(response, deadline)) {
        if (!message.data || message.data === '[DONE]') continue
        const event: unknown = JSON.parse(message.data)
        if (!event || typeof event !== 'object' || !('type' in event)) continue
        if (event.type === 'response.output_item.done' && 'item' in event)
          items.push(event.item)
        if (
          event.type === 'response.completed'
          && 'response' in event
          && event.response
          && typeof event.response === 'object'
        )
          completed = event.response
      }
      const output =
        Array.isArray(completed?.output) && completed.output.length ?
          completed.output
        : items
      return extractWebSearchResult(
        output,
        typeof completed?.output_text === 'string' ? completed.output_text : '',
      )
    } catch (error) {
      // Only a client disconnect ends the turn; a slow or broken search is
      // reported to the model so it can continue without the result.
      if (signal.aborted) throw error
      return failed(
        deadline.aborted ?
          `Web search for ${model.id} timed out.`
        : `Web search failed: ${error instanceof Error ? error.message : 'unknown error'}.`,
      )
    }
  }

  private deadline(signal: AbortSignal) {
    return AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeout)])
  }

  private async failure(
    id: string,
    token: CopilotToken,
    response: Response,
  ): Promise<Response> {
    if (response.status === 401) this.tokens.delete(id)
    const text = (await readBoundedText(response, 64 * 1024))
      .split(token.token)
      .join('[redacted]')
      .split(this.credentials.get(id))
      .join('[redacted]')
    const headers = new Headers({
      'Content-Type': response.headers.get('content-type') ?? 'text/plain',
    })
    for (const name of ['retry-after', 'x-request-id']) {
      const value = response.headers.get(name)
      if (value) headers.set(name, value)
    }
    return new Response(text, { status: response.status, headers })
  }
}

function eventStream(iterator: AsyncGenerator<ResponseStreamEvent>) {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next()
        if (next.done) controller.close()
        else
          controller.enqueue(
            encoder.encode(
              `event: ${next.value.type}\ndata: ${JSON.stringify(next.value)}\n\n`,
            ),
          )
      },
      async cancel() {
        await iterator.return(undefined)
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  )
}
