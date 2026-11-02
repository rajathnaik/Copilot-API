import { createHash, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { z } from 'zod'
import { ResponsesMessagesTranslationError } from '../providers/copilot-compatibility/messages-translation'
import { protocolSchema, modelCapabilities, type Protocol } from '../contracts'
import { createCodexCatalog } from '../harnesses/codex-catalog'
import {
  SourceService,
  sourceHeaders,
  readBoundedText,
} from '../sources/source-service'
import { meteredFetch, type UpstreamUsage } from '../usage/usage-meter'
import type { UsageEntry } from '../usage/usage-ledger'

export interface UsageRecorder {
  record(entry: UsageEntry): void
}

function matchesKey(received: string | undefined, key: string): boolean {
  if (!received) return false
  const expected = Buffer.from(`Bearer ${key}`)
  const actual = Buffer.from(received)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
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
) {
  if (!key.trim()) throw new Error('A gateway access key is required.')
  const app = new Hono()
  app.use('*', async (context, next) => {
    if (!matchesKey(context.req.header('authorization'), key))
      return context.json(
        { error: { message: 'Gateway authentication required.' } },
        401,
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
  for (const protocol of protocolSchema.options) {
    app.post(`/v1/${endpoints[protocol]}`, async (context) => {
      let body: unknown
      try {
        body = await context.req.json()
      } catch (error) {
        if (error instanceof SyntaxError)
          throw new HTTPException(400, {
            message: 'Request body must be valid JSON.',
          })
        throw error
      }
      if (
        !body
        || typeof body !== 'object'
        || !('model' in body)
        || typeof body.model !== 'string'
      )
        return context.json(
          { error: { message: 'A source-qualified model is required.' } },
          400,
        )
      const route = sources.resolve(body.model, sharedOnly)
      if (!route)
        return context.json(
          { error: { message: 'Model is not available on this gateway.' } },
          404,
        )
      if (route.model.protocol !== protocol)
        return context.json(
          {
            error: {
              message:
                'This model does not support the requested native protocol. Cross-protocol adapters are not enabled.',
            },
          },
          422,
        )
      const sourceKey = sources.credentials.get(route.source.id)
      const conversation = context.req.header('session_id')
      if (conversation && conversation.length > 256)
        return context.json(
          {
            error: { message: 'The session_id header exceeds 256 characters.' },
          },
          400,
        )
      const headersForSource = sourceHeaders(route.source, protocol, sourceKey)
      if (conversation) headersForSource.set('session_id', conversation)
      const source = route.source
      const report =
        usage
        && ((entry: UpstreamUsage) =>
          usage.record({
            ...entry,
            sourceId: source.id,
            source: source.label,
            kind: source.kind,
            access: sharedOnly ? 'remote' : 'local',
          }))
      let response: Response
      try {
        const signal = AbortSignal.any([
          context.req.raw.signal,
          AbortSignal.timeout(120_000),
        ])
        response =
          route.source.kind === 'copilot' ?
            // Copilot applies the deadline per upstream request because one
            // proxied web-search turn can span several requests.
            await sources.copilot.forward(
              route.source,
              route.model.upstreamProtocol ?? protocol,
              { ...body, model: route.model.id },
              context.req.raw.signal,
              conversation,
              report,
            )
          : await meteredFetch(
              sources.fetcher,
              `${route.source.baseUrl}/${endpoints[protocol]}`,
              {
                method: 'POST',
                headers: headersForSource,
                body: JSON.stringify({ ...body, model: route.model.id }),
                redirect: 'error',
                signal,
              },
              report,
              {
                model: route.model.id,
                purpose: 'request',
                client: context.req.raw.signal,
              },
            )
      } catch (error) {
        if (error instanceof ResponsesMessagesTranslationError)
          return Response.json(
            { error: { message: error.message } },
            { status: error.status },
          )
        if (error instanceof z.ZodError)
          return context.json(
            {
              error: {
                message:
                  'The Copilot request has invalid fields. Check its input, tools and output limits.',
              },
            },
            400,
          )
        console.error(
          `[ModelBridge] Source request failed (${error instanceof Error ? error.name : 'Unknown failure'}).`,
        )
        return context.json(
          {
            error: {
              message:
                'The selected source could not be reached. No fallback source was used.',
            },
          },
          502,
        )
      }
      const headers = new Headers()
      for (const name of ['content-type', 'retry-after', 'x-request-id']) {
        const value = response.headers.get(name)
        if (value) headers.set(name, value)
      }
      if (!response.ok)
        return new Response(
          (await readBoundedText(response, 64 * 1024))
            .split(sourceKey)
            .join('[redacted]'),
          { status: response.status, headers },
        )
      return new Response(response.body, { status: response.status, headers })
    })
  }
  app.onError((error, context) => {
    if (error instanceof HTTPException)
      return context.json({ error: { message: error.message } }, error.status)
    console.error(`[ModelBridge] Request failed (${error.name}).`)
    return context.json(
      {
        error: {
          message:
            'Gateway request failed. Check ModelBridge source status and saved credentials.',
        },
      },
      500,
    )
  })
  return app
}
