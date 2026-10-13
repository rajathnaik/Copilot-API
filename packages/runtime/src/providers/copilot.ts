import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { events } from 'fetch-event-stream'
import {
  translateResponsesToMessages,
  translateAnthropicToResponses,
  ResponsesMessagesTranslationError,
} from './copilot-compatibility/messages-translation'
import { translateMessagesStream } from './copilot-compatibility/messages-stream-translation'
import { requestContext } from './copilot-compatibility/context'
import type { AnthropicResponse } from './copilot-compatibility/anthropic'
import type { Credentials, Protocol, Source } from '../contracts'
import { reasoningEffortSchema } from '../contracts'
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
  ) {}

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
      'editor-version': 'vscode/1.109.0',
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
        contextWindow: model.capabilities?.limits?.max_context_window_tokens,
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

  async forward(
    source: Source,
    protocol: Protocol,
    body: Record<string, unknown>,
    signal: AbortSignal,
    conversation?: string,
  ): Promise<Response> {
    const token = await this.token(source.id)
    const headers = this.headers(token, false, conversation)
    const input = body.input
    const last: unknown = Array.isArray(input) ? input.at(-1) : undefined
    const initiator =
      last && typeof last === 'object' ?
        !('role' in last)
        || !last.role
        || (typeof last.role === 'string'
          && last.role.toLowerCase() === 'assistant')
      : false
    headers.set('x-initiator', initiator ? 'agent' : 'user')
    if (JSON.stringify(body).includes('"input_image"'))
      headers.set('copilot-vision-request', 'true')
    const endpoint =
      protocol === 'messages' ? '/v1/messages'
      : protocol === 'chat-completions' ? '/chat/completions'
      : '/responses'
    const payload = { ...body }
    const model = source.models.find((item) => item.id === body.model)
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
    const translation =
      protocol !== 'responses' ?
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
            .parse(payload)
          return translateResponsesToMessages(
            { ...payload, model: z.string().parse(payload.model) },
            { model: z.string().parse(payload.model) },
          )
        })
      : null
    const chat =
      translation && protocol === 'chat-completions' ?
        requestContext.run({ sessionAffinity: conversation }, () =>
          translateToOpenAI(translation.messagesPayload, {
            validateReasoningEffort: !!model?.reasoningEfforts?.length,
            reasoningEffortSupport: model?.reasoningEfforts,
          }),
        )
      : null
    if (chat && payload.stream) chat.stream_options = { include_usage: true }
    const response = await this.fetcher(`${token.api}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(chat ?? translation?.messagesPayload ?? payload),
      redirect: 'error',
      signal,
    })
    if (response.status === 401) this.tokens.delete(source.id)
    if (!response.ok) {
      const text = (await readBoundedText(response, 64 * 1024))
        .split(token.token)
        .join('[redacted]')
        .split(this.credentials.get(source.id))
        .join('[redacted]')
      const errorHeaders = new Headers({
        'Content-Type': response.headers.get('content-type') ?? 'text/plain',
      })
      for (const name of ['retry-after', 'x-request-id']) {
        const value = response.headers.get(name)
        if (value) errorHeaders.set(name, value)
      }
      return new Response(text, {
        status: response.status,
        headers: errorHeaders,
      })
    }
    if (!translation) return response
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
    const iterator = translateMessagesStream(
      chat ? chatAsMessages(response) : events(response),
      translation,
    )
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = await iterator.next()
          if (next.done) controller.close()
          else
            controller.enqueue(
              new TextEncoder().encode(
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
}
