import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { createGateway, SourceService } from '@modelbridge/runtime'
import type { Credentials } from '@modelbridge/runtime'
import type { Protocol } from '@modelbridge/runtime/contracts'
import { CopilotProvider } from '@modelbridge/runtime/copilot'
import { CodexConfigurations } from '@modelbridge/runtime/codex'

const requestSchema = z
  .object({
    model: z.string(),
    input: z.array(z.record(z.string(), z.unknown())).optional(),
    tools: z.array(z.record(z.string(), z.unknown())).optional(),
    messages: z
      .array(
        z
          .object({
            role: z.string(),
            content: z
              .union([z.string(), z.array(z.record(z.string(), z.unknown()))])
              .nullish(),
            tool_call_id: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough()

function streamResponse(
  model: string,
  item: Record<string, unknown>,
  deltas: Array<Record<string, unknown> & { type: string }> = [],
) {
  const response = {
    id: 'resp_probe',
    object: 'response',
    created_at: 1,
    status: 'completed',
    model,
    output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }
  return [
    {
      type: 'response.created',
      response: { ...response, status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress' },
    },
    ...deltas,
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ]
    .map(
      (event, sequence_number) =>
        `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
    )
    .join('')
}

function completion(model: string, text: string) {
  const item = {
    type: 'message',
    id: 'msg_probe',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  }
  return streamResponse(model, item, [
    {
      type: 'response.output_text.delta',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: 'response.output_text.done',
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text,
    },
  ])
}
function adapterCompletion(
  protocol: Protocol,
  model: string,
  text: string,
  tool?: { name: string; arguments: string },
) {
  if (protocol === 'responses')
    return tool ?
        streamResponse(model, {
          type: 'function_call',
          id: 'fc_probe',
          call_id: 'probe_call',
          ...tool,
        })
      : completion(model, text)
  if (protocol === 'chat-completions') {
    const chunk = {
      id: 'chat_probe',
      model,
      object: 'chat.completion.chunk',
      created: 1,
    }
    return [
      {
        ...chunk,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              ...(tool ?
                {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'probe_call',
                      type: 'function',
                      function: tool,
                    },
                  ],
                }
              : { content: text }),
            },
            finish_reason: null,
          },
        ],
      },
      {
        ...chunk,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: tool ? 'tool_calls' : 'stop',
          },
        ],
      },
      {
        ...chunk,
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join('')
  }
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_probe',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block:
        tool ?
          { type: 'tool_use', id: 'probe_call', name: tool.name, input: {} }
        : { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta:
        tool ?
          { type: 'input_json_delta', partial_json: tool.arguments }
        : { type: 'text_delta', text },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: {
        stop_reason: tool ? 'tool_use' : 'end_turn',
        stop_sequence: null,
      },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('')
}
function memoryCredentials(): Credentials {
  const values = new Map<string, string>()
  return {
    get(id) {
      const value = values.get(id)
      if (!value) throw new Error('Synthetic credential missing.')
      return value
    },
    set: (id, value) => {
      values.set(id, value)
    },
    remove: (id) => {
      values.delete(id)
    },
  }
}

test
  .skipIf(!process.env.MODELBRIDGE_TEST_CODEX)
  .each<Protocol>(['responses', 'messages', 'chat-completions'])(
  'installed Codex discovers managed models and completes consumer tools through direct Copilot %s across host and consumer gateways',
  async (protocol) => {
    const codex = process.env.MODELBRIDGE_TEST_CODEX
    if (!codex)
      throw new Error(
        'Set MODELBRIDGE_TEST_CODEX to the Codex console executable.',
      )
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'modelbridge-codex-'),
    )
    const home = path.join(directory, 'codex')
    fs.mkdirSync(home)
    const nativeAuth =
      '{"OPENAI_API_KEY":"synthetic-native-account-do-not-use"}'
    fs.writeFileSync(path.join(home, 'auth.json'), nativeAuth)
    const requests: Array<z.infer<typeof requestSchema>> = []
    let toolsPhase = false
    let toolRoundtrip = false
    const provider = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (
          request.headers.get('authorization')
          !== 'Bearer synthetic-provider-key'
        )
          return new Response('wrong provider credential', { status: 401 })
        if (new URL(request.url).pathname === '/v1/models')
          return Response.json({
            data: ['probe-a', 'probe-b'].map((id) => ({
              id,
              name: id.toUpperCase(),
              supported_endpoints: [
                protocol === 'messages' ? '/v1/messages'
                : protocol === 'chat-completions' ? '/chat/completions'
                : '/responses',
              ],
              capabilities: {
                supports: { tool_calls: true },
                limits: { max_context_window_tokens: 32000 },
              },
              modelbridge: {
                protocol: 'responses',
                supportsTools: true,
                contextWindow: 32000,
              },
            })),
          })
        const body = requestSchema.parse(await request.json())
        requests.push(body)
        if (!['probe-a', 'probe-b'].includes(body.model))
          return new Response('wrong model route', { status: 400 })
        let output = adapterCompletion(
          protocol,
          body.model,
          `MODELBRIDGE_CODEX_${body.model}_OK`,
        )
        if (toolsPhase) {
          const directResult = body.input?.find(
            (item) =>
              item.type === 'function_call_output'
              && item.call_id === 'probe_call',
          )
          const messageResult = body.messages
            ?.flatMap((message) =>
              typeof message.content === 'string' ?
                [
                  {
                    tool_call_id: message.tool_call_id,
                    output: message.content,
                  },
                ]
              : (message.content?.map((content) => ({
                  tool_call_id: content.tool_use_id ?? message.tool_call_id,
                  output:
                    typeof content.content === 'string' ?
                      content.content
                    : JSON.stringify(content.content ?? content.text),
                })) ?? []),
            )
            .find((item) => item.tool_call_id === 'probe_call')
          const result = directResult ?? messageResult
          if (result) {
            if (
              typeof result.output !== 'string'
              || !result.output.includes('MODELBRIDGE_TOOL_OK')
            )
              return new Response(
                'Consumer tool did not return the expected matching output.',
                { status: 400 },
              )
            toolRoundtrip = true
            output = adapterCompletion(
              protocol,
              body.model,
              'MODELBRIDGE_TOOL_ROUNDTRIP_OK',
            )
          } else {
            if (
              !body.tools?.some(
                (tool) =>
                  tool.name === 'exec_command'
                  || (tool.function
                    && typeof tool.function === 'object'
                    && 'name' in tool.function
                    && tool.function.name === 'exec_command'),
              )
            )
              return new Response(
                'Codex did not offer the observed exec_command tool.',
                { status: 400 },
              )
            output = adapterCompletion(protocol, body.model, '', {
              name: 'exec_command',
              arguments: JSON.stringify({
                cmd: "Write-Output 'MODELBRIDGE_TOOL_OK'",
                shell: 'powershell.exe',
                workdir: directory,
                yield_time_ms: 1000,
                max_output_tokens: 200,
              }),
            })
          }
        }
        return new Response(output, {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    const hostVault = memoryCredentials()
    const copilot = new CopilotProvider(hostVault, (url, init) => {
      if (url.endsWith('/token'))
        return Promise.resolve(
          Response.json({
            token: 'synthetic-provider-key',
            refresh_in: 120,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          }),
        )
      const endpoint = url.endsWith('/models') ? '/v1/models' : '/v1/inference'
      return fetch(`http://127.0.0.1:${provider.port}${endpoint}`, init)
    })
    const hostSources = new SourceService(
      [],
      hostVault,
      () => {},
      fetch,
      copilot,
    )
    const host = createGateway(hostSources, 'synthetic-host-key', true)
    const hostServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: host.fetch,
    })
    const consumerSources = new SourceService([], memoryCredentials(), () => {})
    const consumer = createGateway(consumerSources, 'synthetic-consumer-key')
    let catalogRequests = 0
    const consumerServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === '/v1/codex/models')
          catalogRequests++
        return consumer.fetch(request)
      },
    })
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: home,
      MODELBRIDGE_SYNTHETIC_TOKEN: 'synthetic-consumer-key',
    }
    delete env.OPENAI_API_KEY
    delete env.CODEX_API_KEY
    const url = `http://127.0.0.1:${consumerServer.port}/v1`
    const config = [
      '-c',
      'features.api_key_model_discovery=true',
      '-c',
      'model_provider="modelbridge_probe"',
      '-c',
      'model_providers.modelbridge_probe.name="ModelBridge isolated proof"',
      '-c',
      `model_providers.modelbridge_probe.base_url="${url}"`,
      '-c',
      `model_providers.modelbridge_probe.model_catalog_url="${url}/codex/models"`,
      '-c',
      'model_providers.modelbridge_probe.env_key="MODELBRIDGE_SYNTHETIC_TOKEN"',
      '-c',
      'model_providers.modelbridge_probe.wire_api="responses"',
      '-c',
      'model_providers.modelbridge_probe.requires_openai_auth=false',
      '-c',
      'model_providers.modelbridge_probe.supports_websockets=false',
      '-c',
      'web_search="disabled"',
    ]
    try {
      await hostSources.addCopilot(
        'synthetic-github',
        'Synthetic Copilot',
        true,
      )
      await consumerSources.add({
        label: 'Synthetic remote host',
        kind: 'remote',
        baseUrl: `http://127.0.0.1:${hostServer.port}`,
        protocol: 'responses',
        apiKey: 'synthetic-host-key',
        shared: false,
      })
      const models = consumerSources.models()
      expect(models).toHaveLength(2)
      expect(
        models.every(
          (model) => model.supportsTools && model.contextWindow === 32000,
        ),
      ).toBe(true)

      const child = Bun.spawn({
        cmd: [codex, ...config, 'app-server'],
        cwd: directory,
        env,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const rpcTimeout = setTimeout(() => child.kill(), 30_000)
      const rpcStderr = new Response(child.stderr).text()
      const replies = new Map<number, unknown>()
      const notifications: unknown[] = []
      const read = (async () => {
        const decoder = new TextDecoder()
        let buffer = ''
        const reader = child.stdout.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let newline = buffer.indexOf('\n')
          while (newline >= 0) {
            const message = z
              .object({
                id: z.number().optional(),
                result: z.unknown().optional(),
                error: z.object({ message: z.string() }).optional(),
              })
              .passthrough()
              .parse(JSON.parse(buffer.slice(0, newline)))
            buffer = buffer.slice(newline + 1)
            if (message.id !== undefined) replies.set(message.id, message)
            else notifications.push(message)
            newline = buffer.indexOf('\n')
          }
        }
        reader.releaseLock()
      })()
      const send = async (id: number, method: string, params: unknown) => {
        await child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
        await child.stdin.flush()
        const deadline = Date.now() + 20_000
        while (!replies.has(id)) {
          if (Date.now() > deadline || child.exitCode !== null)
            throw new Error(`Codex RPC ${method} did not respond.`)
          await Bun.sleep(20)
        }
        const reply = z
          .object({
            result: z.unknown().optional(),
            error: z.object({ message: z.string() }).optional(),
          })
          .parse(replies.get(id))
        if (reply.error)
          throw new Error(`Codex RPC ${method}: ${reply.error.message}`)
        return reply.result
      }
      try {
        await send(1, 'initialize', {
          clientInfo: { name: 'modelbridge-compatibility', version: '0.1.0' },
        })
        await child.stdin.write('{"method":"initialized"}\n')
        await child.stdin.flush()
        const result = z
          .object({
            data: z.array(
              z.object({
                model: z.string(),
                displayName: z.string(),
                hidden: z.boolean(),
              }),
            ),
            nextCursor: z.string().nullable(),
          })
          .parse(
            await send(2, 'model/list', { includeHidden: false, limit: 100 }),
          )
        console.info(
          'Codex native discovery:',
          JSON.stringify({ catalogRequests, result }),
        )
        expect(result.data.map((model) => model.model)).toEqual(
          models.map((model) => model.id),
        )
        expect(
          result.data.every(
            (model) =>
              !model.hidden
              && model.displayName.includes('Synthetic remote host'),
          ),
        ).toBe(true)
        expect(result.nextCursor).toBeNull()
      } finally {
        clearTimeout(rpcTimeout)
        await child.stdin.end()
        child.kill()
        await child.exited
        await read
        const stderr = await rpcStderr
        if (stderr)
          console.info('Codex app-server diagnostics:', stderr.slice(-6000))
      }

      const helperFile = path.join(directory, 'key-helper.cjs')
      fs.writeFileSync(
        helperFile,
        "process.stdout.write('synthetic-consumer-key')",
      )
      fs.writeFileSync(
        path.join(home, 'config.toml'),
        '# Isolated native Codex settings\nweb_search = "disabled"\n',
      )
      const configurations = new CodexConfigurations(
        path.join(home, 'config.toml'),
        path.join(directory, 'revisions'),
        memoryCredentials(),
        { command: 'node', args: [helperFile] },
      )
      const plan = configurations.preview(
        'Synthetic remote Copilot',
        models[0].id,
        models,
        url,
      )
      configurations.apply(plan.id)
      for (const [index, model] of [...models, models[0]].entries()) {
        toolsPhase = index === 2
        const process = Bun.spawn({
          cmd: [
            codex,
            '-c',
            `model="${model.id}"`,
            'exec',
            '--ephemeral',
            '--skip-git-repo-check',
            '--json',
            '-s',
            'read-only',
            toolsPhase ?
              'Run the provided harmless tool once, then give a short reply.'
            : 'Return a short greeting. Do not run tools.',
          ],
          cwd: directory,
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const timeout = setTimeout(() => process.kill(), 45_000)
        try {
          const [stdout, stderr, code] = await Promise.all([
            new Response(process.stdout).text(),
            new Response(process.stderr).text(),
            process.exited,
          ])
          expect(code, `${stdout}\n${stderr}`).toBe(0)
          expect(stdout).toContain(
            toolsPhase ?
              'MODELBRIDGE_TOOL_ROUNDTRIP_OK'
            : `MODELBRIDGE_CODEX_${model.id.endsWith('/probe-a') ? 'probe-a' : 'probe-b'}_OK`,
          )
        } finally {
          clearTimeout(timeout)
          if (process.exitCode === null) {
            process.kill()
            await process.exited
          }
        }
      }
      expect(requests.map((request) => request.model)).toEqual([
        'probe-a',
        'probe-b',
        'probe-a',
        'probe-a',
      ])
      expect(toolRoundtrip).toBe(true)
      expect(catalogRequests).toBeGreaterThanOrEqual(1)
      expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).toContain(
        'requires_openai_auth = false',
      )
      expect(
        fs.readFileSync(path.join(home, 'config.toml'), 'utf8'),
      ).not.toContain('synthetic-consumer-key')
      configurations.apply(configurations.restore().id)
      expect(
        fs.readFileSync(path.join(home, 'config.toml'), 'utf8'),
      ).not.toContain('[model_providers.modelbridge]')
      expect(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).toBe(
        nativeAuth,
      )
      console.info(
        'Codex offered tool shapes:',
        JSON.stringify(
          requests[0]?.tools?.map((tool) => ({
            type: tool.type,
            name: tool.name,
            parameterNames:
              (
                tool.parameters
                && typeof tool.parameters === 'object'
                && 'properties' in tool.parameters
              ) ?
                Object.keys(tool.parameters.properties as object)
              : [],
          })),
        ),
      )
    } finally {
      await Promise.all([
        provider.stop(true),
        hostServer.stop(true),
        consumerServer.stop(true),
      ])
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
  150_000,
)
