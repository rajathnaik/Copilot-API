import { createHash, timingSafeEqual } from 'node:crypto'
import { Hono, type Context } from 'hono'

import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { ResponsesMessagesTranslationError } from '../providers/copilot-compatibility/messages-translation'
import {
  directProtocols,
  protocolSchema,
  modelCapabilities,
  type Protocol,
} from '../contracts'
import {
  AdapterError,
  errorMessage,
  record,
  sseResponseBody,
} from '../adapters/json'
import {
  chatToResponsesRequest,
  responsesStreamToChat,
  responsesToChatResponse,
} from '../adapters/chat-completions'
import {
  anthropicErrorType,
  messagesToResponsesRequest,
  responsesStreamToMessages,
  responsesToMessagesResponse,
} from '../adapters/anthropic-messages'
import { createCodexCatalog } from '../harnesses/codex-catalog'
import {
  SourceService,
  sourceHeaders,
  readBoundedText,
} from '../sources/source-service'
import { meteredFetch, type UpstreamUsage } from '../usage/usage-meter'
import { stabilizeResponseItemIds } from './stable-item-ids'
import { unnamedClientLabel, type UsageEntry } from '../usage/usage-ledger'

export interface UsageRecorder {
  record(entry: UsageEntry): void
}

export interface GatewayOptions {
  // Name this machine reports to remote ModelBridge hosts.
  clientName?: () => string | undefined
}

export const clientHeader = 'x-modelbridge-client'

// Client names are self-reported labels, not identities; they are cleaned so
// the host's dashboard and limits stay readable.
export function cleanClientName(value: string | null | undefined): string {
  const name = (value ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 64)
    .trim()
  return name || unnamedClientLabel
}

function matches(received: string | undefined, expected: string): boolean {
  if (!received) return false
  const wanted = Buffer.from(expected)
  const actual = Buffer.from(received)
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

// Anthropic clients such as Claude Code send the key in `x-api-key`.
function authorized(
  authorization: string | undefined,
  apiKey: string | undefined,
  key: string,
): boolean {
  return matches(authorization, `Bearer ${key}`) || matches(apiKey, key)
}

function isMessagesPath(path: string): boolean {
  return /\/v1\/messages(?:\/count_tokens)?$/u.test(path)
}

// Errors use the error format of the client's protocol.
function fail(
  protocol: Protocol,
  status: number,
  message: string,
  headers?: Headers,
): Response {
  const body =
    protocol === 'messages' ?
      { type: 'error', error: { type: anthropicErrorType(status), message } }
    : { error: { message } }
  const output = new Headers(headers)
  output.set('content-type', 'application/json')
  return new Response(JSON.stringify(body), { status, headers: output })
}

async function readJson(context: Context): Promise<unknown> {
  try {
    return await context.req.json()
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new HTTPException(400, {
        message: 'Request body must be valid JSON.',
      })
    throw error
  }
}
const endpoints: Record<Protocol, string> = {
  responses: 'responses',
  messages: 'messages',
  'chat-completions': 'chat/completions',
}

export function createGateway(
  sources: SourceService,
  key: string,
  sharedOnly = false,
  usage?: UsageRecorder,
  options: GatewayOptions = {},
) {
  if (!key.trim()) throw new Error('A gateway access key is required.')
  const app = new Hono()
  app.use('*', async (context, next) => {
    if (
      !authorized(
        context.req.header('authorization'),
        context.req.header('x-api-key'),
        key,
      )
    )
      return fail(
        isMessagesPath(context.req.path) ? 'messages' : 'responses',
        401,
        'Gateway authentication required.',
      )
    await next()
  })
  app.use('*', bodyLimit({ maxSize: 8 * 1024 * 1024 }))
  app.get('/health', (context) =>
    context.json({ product: 'ModelBridge', status: 'ready' }),
  )
  app.get('/v1/models', (context) =>
    context.json({
      object: 'list',
      data: sources.models(sharedOnly).map((model) => ({
        id: model.id,
        name: model.name,
        object: 'model',
        modelbridge: {
          protocol: model.protocol,
          protocols: model.protocols,
          source: model.sourceLabel,
          ...modelCapabilities(model),
        },
      })),
    }),
  )
  app.get('/v1/codex/models', (context) => {
    const catalog = createCodexCatalog(sources.models(sharedOnly))
    if (!catalog.models.length)
      return context.json(
        {
          error: {
            message:
              'No Responses-compatible models are available for Codex on this gateway.',
          },
        },
        422,
      )
    const body = JSON.stringify(catalog)
    if (Buffer.byteLength(body) > 1024 * 1024)
      return context.json(
        {
          error: {
            message:
              'The Codex catalog exceeds its 1 MiB client limit. Reduce the exposed model set.',
          },
        },
        413,
      )
    const etag = `"${createHash('sha256').update(body).digest('hex')}"`
    const headers = {
      ETag: etag,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache',
    }
    if (context.req.header('if-none-match') === etag)
      return context.body(null, 304, headers)
    return context.body(body, 200, headers)
  })
  // Claude Code checks prompt sizes before sending; an estimate is enough.
  app.post('/v1/messages/count_tokens', async (context) => {
    const body = record(await readJson(context))
    const size = JSON.stringify({
      system: body?.system,
      messages: body?.messages,
      tools: body?.tools,
    }).length
    return context.json({ input_tokens: Math.ceil(size / 4) })
  })
  for (const protocol of protocolSchema.options) {
    app.post(`/v1/${endpoints[protocol]}`, async (context) => {
      const body = record(await readJson(context))
      if (!body || typeof body.model !== 'string')
        return fail(protocol, 400, 'A source-qualified model is required.')
      const requestedModel = body.model
      const route = sources.resolve(requestedModel, sharedOnly)
      if (!route)
        return fail(protocol, 404, 'Model is not available on this gateway.')
      const { source, model } = route
      const direct = directProtocols(source, model)
      // `model`: the model's own protocol. `native`: Copilot serves the
      // protocol directly. `direct`: the source accepts it as is. `hub`: the
      // request is translated to Responses and the answer translated back.
      const mode =
        protocol === model.protocol ? 'model'
        : direct.includes(protocol) ?
          source.kind === 'copilot' ?
            'native'
          : 'direct'
        : direct.includes('responses') ? 'hub'
        : undefined
      if (!mode)
        return fail(
          protocol,
          422,
          `This model does not accept /v1/${endpoints[protocol]} requests. Use ${direct.map((item) => `/v1/${endpoints[item]}`).join(' or ')}.`,
        )
      const sourceKey = sources.credentials.get(source.id)
      const conversation = context.req.header('session_id')
      if (conversation && conversation.length > 256)
        return fail(
          protocol,
          400,
          'The session_id header exceeds 256 characters.',
        )
      const client =
        sharedOnly ? cleanClientName(context.req.header(clientHeader)) : null
      const report =
        usage
        && ((entry: UpstreamUsage) =>
          usage.record({
            ...entry,
            sourceId: source.id,
            source: source.label,
            kind: source.kind,
            access: sharedOnly ? 'remote' : 'local',
            ...(client && { client }),
          }))
      const upstreamProtocol: Protocol = mode === 'hub' ? 'responses' : protocol
      let response: Response
      try {
        const payload = {
          ...(mode === 'hub' ?
            protocol === 'messages' ?
              messagesToResponsesRequest(body, model)
            : chatToResponsesRequest(body, model)
          : body),
          model: model.id,
        }
        if (source.kind === 'copilot')
          // Copilot applies the deadline per upstream request because one
          // proxied web-search turn can span several requests.
          response =
            mode === 'native' && protocol !== 'responses' ?
              await sources.copilot.forwardNative(
                source,
                protocol,
                payload,
                context.req.raw.signal,
                conversation,
                report,
              )
            : await sources.copilot.forward(
                source,
                model.upstreamProtocol ?? upstreamProtocol,
                payload,
                context.req.raw.signal,
                conversation,
                report,
              )
        else {
          const headersForSource = sourceHeaders(
            source,
            upstreamProtocol,
            sourceKey,
          )
          if (conversation) headersForSource.set('session_id', conversation)
          if (source.kind === 'remote') {
            const name = options.clientName?.()
            if (name) headersForSource.set(clientHeader, cleanClientName(name))
          }
          response = await meteredFetch(
            sources.fetcher,
            `${source.baseUrl}/${endpoints[upstreamProtocol]}`,
            {
              method: 'POST',
              headers: headersForSource,
              body: JSON.stringify(payload),
              redirect: 'error',
              signal: AbortSignal.any([
                context.req.raw.signal,
                AbortSignal.timeout(120_000),
              ]),
            },
            report,
            {
              model: model.id,
              purpose: 'request',
              client: context.req.raw.signal,
            },
          )
        }
      } catch (error) {
        if (
          error instanceof AdapterError
          || error instanceof ResponsesMessagesTranslationError
        )
          return fail(protocol, error.status, error.message)
        if (error instanceof z.ZodError)
          return fail(
            protocol,
            400,
            'The Copilot request has invalid fields. Check its input, tools and output limits.',
          )
        console.error(
          `[ModelBridge] Source request failed (${error instanceof Error ? error.name : 'Unknown failure'}).`,
        )
        return fail(
          protocol,
          502,
          'The selected source could not be reached. No fallback source was used.',
        )
      }
      const headers = new Headers()
      for (const name of ['content-type', 'retry-after', 'x-request-id']) {
        const value = response.headers.get(name)
        if (value) headers.set(name, value)
      }
      if (!response.ok) {
        const text = (await readBoundedText(response, 64 * 1024))
          .split(sourceKey)
          .join('[redacted]')
        return mode === 'hub' ?
            fail(
              protocol,
              response.status,
              errorMessage(text, response.status),
              headers,
            )
          : new Response(text, { status: response.status, headers })
      }
      const streaming =
        !!response.body
        && (response.headers.get('content-type') ?? '').includes(
          'text/event-stream',
        )
      const output =
        streaming && response.body && upstreamProtocol === 'responses' ?
          stabilizeResponseItemIds(response.body)
        : response.body
      if (mode !== 'hub')
        return new Response(output, { status: response.status, headers })
      if (streaming && output) {
        headers.set('content-type', 'text/event-stream')
        headers.set('cache-control', 'no-cache')
        const frames =
          protocol === 'messages' ?
            responsesStreamToMessages(output, requestedModel)
          : responsesStreamToChat(
              output,
              requestedModel,
              record(body.stream_options)?.include_usage === true,
            )
        return new Response(sseResponseBody(frames), { status: 200, headers })
      }
      let result: Record<string, unknown> | undefined
      try {
        result = record(
          JSON.parse(await readBoundedText(response, 16 * 1024 * 1024)),
        )
      } catch {
        result = undefined
      }
      if (!result)
        return fail(protocol, 502, 'The source returned an invalid response.')
      headers.set('content-type', 'application/json')
      return new Response(
        JSON.stringify(
          protocol === 'messages' ?
            responsesToMessagesResponse(result, requestedModel)
          : responsesToChatResponse(result, requestedModel),
        ),
        { status: 200, headers },
      )
    })
  }
  app.onError((error, context) => {
    const protocol = isMessagesPath(context.req.path) ? 'messages' : 'responses'
    if (error instanceof HTTPException)
      return fail(protocol, error.status, error.message)
    console.error(`[ModelBridge] Request failed (${error.name}).`)
    return fail(
      protocol,
      500,
      'Gateway request failed. Check ModelBridge source status and saved credentials.',
    )
  })
  return app
}
