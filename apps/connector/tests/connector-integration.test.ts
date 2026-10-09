import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import catalog from './fixtures/codex-catalog.json'
import { detectCodex, runCommand } from '../electron/connector/codex'
import { ConnectorService } from '../electron/connector/service'
import { ConnectorStore } from '../electron/connector/store'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function events(
  response: Record<string, unknown>,
  item: Record<string, unknown>,
  text?: string,
) {
  const data: Array<Record<string, unknown>> = [
    {
      type: 'response.created',
      response: { ...response, status: 'in_progress', output: [] },
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, content: [] },
    },
  ]
  if (text) {
    data.push(
      {
        type: 'response.content_part.added',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '' },
      },
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
      {
        type: 'response.content_part.done',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text },
      },
    )
  }
  data.push(
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  )
  return new Response(
    data.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  )
}

test.skipIf(!process.env.CONNECTOR_TEST_CODEX)(
  'real Codex CLI uses installed provider, catalog and credential helper against a local gateway',
  async () => {
    const executable = process.env.CONNECTOR_TEST_CODEX
    if (!executable)
      throw new Error(
        'Set CONNECTOR_TEST_CODEX to the native Codex executable.',
      )
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'connector-native-'),
    )
    const credential = 'synthetic-connector-integration-key'
    const model = {
      ...catalog.models[0],
      slug: 'gpt-connector-test',
      display_name: 'Connector Test',
      supported_in_api: true,
    }
    const requests: Array<{ path: string; authenticated: boolean }> = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname
        const authenticated =
          request.headers.get('authorization') === `Bearer ${credential}`
        requests.push({ path: pathname, authenticated })
        if (!authenticated)
          return Response.json({ error: 'unauthorized' }, { status: 401 })
        if (pathname === '/v1/models')
          return Response.json({ data: [{ id: model.slug }] })
        if (pathname === '/models') return Response.json({ models: [model] })
        if (pathname !== '/responses')
          return Response.json({ error: 'not found' }, { status: 404 })
        const body: unknown = await request.json()
        if (!isRecord(body))
          return Response.json({ error: 'invalid request' }, { status: 400 })
        const probe =
          Array.isArray(body.tools)
          && body.tools.some(
            (tool: unknown) =>
              isRecord(tool) && tool.name === 'connector_probe',
          )
        const text = probe ? undefined : 'COPILOT_CONNECTOR_OK'
        const item =
          probe ?
            {
              id: 'fc_connector',
              type: 'function_call',
              call_id: 'call_connector',
              name: 'connector_probe',
              arguments: '{"ok":true}',
              status: 'completed',
            }
          : {
              id: 'msg_connector',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text, annotations: [] }],
              status: 'completed',
            }
        const response = {
          id: 'resp_connector',
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          status: 'completed',
          model: model.slug,
          output: [item],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        }
        return events(response, item, text)
      },
    })
    try {
      const storage = new ConnectorStore(
        path.join(directory, 'connector'),
        path.join(directory, 'codex', 'config.toml'),
        {
          available: () => true,
          encrypt: (value) => Buffer.from(value).toString('base64'),
          decrypt: (value) => Buffer.from(value, 'base64').toString(),
        },
      )
      const electron = process.env.CONNECTOR_TEST_ELECTRON
      const packagedHelper = process.env.CONNECTOR_TEST_HELPER
      const main = path.resolve('out-connector', 'main', 'index.js')
      const helper = path.join(directory, 'test-helper.cjs')
      const nativeRunner = path.join(directory, 'node-runner.cjs')
      fs.writeFileSync(
        nativeRunner,
        [
          "const { execFile } = require('node:child_process')",
          'const input = JSON.parse(process.argv[2])',
          'const child = execFile(input.command, input.args, { cwd: input.cwd, timeout: input.timeout, maxBuffer: 2 * 1024 * 1024, encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {',
          'if (error) { process.stderr.write(error.message); process.exitCode = 1 }',
          'else process.stdout.write(JSON.stringify({ stdout, stderr }))',
          '})',
          'child.stdin.end()',
        ].join('\n'),
      )
      fs.writeFileSync(
        helper,
        "process.stdout.write(Buffer.from(require('node:fs').readFileSync(process.argv[2], 'utf8'), 'base64').toString())",
      )
      if (electron) {
        if (!fs.existsSync(main))
          throw new Error(
            'Build the connector before testing its Electron credential helper.',
          )
        const encryptor = path.join(directory, 'encrypt-key.cjs')
        fs.writeFileSync(
          encryptor,
          [
            "const { app, safeStorage } = require('electron')",
            "app.setName('Copilot API Connector')",
            "app.setPath('userData', process.argv[2])",
            "const key = require('node:fs').readFileSync(process.argv[3], 'utf8')",
            'app.whenReady().then(() => {',
            "if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable')",
            "process.stdout.write(safeStorage.encryptString(key).toString('base64'), () => app.quit())",
            '}).catch(error => { process.stderr.write(error.message); app.exit(1) })',
          ].join('\n'),
        )
        storage.codec.encrypt = (value) => {
          const fixtureKey = path.join(directory, 'synthetic-key.txt')
          fs.writeFileSync(fixtureKey, value, { mode: 0o600 })
          return execFileSync(
            electron,
            [encryptor, storage.directory, fixtureKey],
            {
              encoding: 'utf8',
              timeout: 30_000,
            },
          ).trim()
        }
        storage.codec.decrypt = () =>
          execFileSync(
            packagedHelper ?? electron,
            [
              ...(packagedHelper ? [] : [main]),
              '--connector-token',
              `--user-data-dir=${storage.directory}`,
            ],
            { encoding: 'utf8', timeout: 30_000 },
          ).trim()
      }
      const service = new ConnectorService(storage, {
        runner: async (command, args, options) => {
          try {
            // Native subprocesses must use the application's Node runtime semantics.
            const output = await runCommand(
              'node',
              [
                nativeRunner,
                JSON.stringify({
                  command,
                  args,
                  cwd: options.cwd,
                  timeout: Math.min(options.timeout, 60_000),
                }),
              ],
              { env: options.env, timeout: 65_000 },
            )
            const result: unknown = JSON.parse(output.stdout)
            if (
              !isRecord(result)
              || typeof result.stdout !== 'string'
              || typeof result.stderr !== 'string'
            )
              throw new Error('The native Node runner returned invalid output.')
            return { stdout: result.stdout, stderr: result.stderr }
          } catch (error) {
            const message =
              error instanceof Error ?
                error.message
              : 'Native verification failed.'
            console.error(
              `Synthetic gateway native diagnostic: ${message.split(credential).join('[redacted]').slice(0, 4000)}`,
            )
            console.error(JSON.stringify(requests))
            throw error
          }
        },
        installation: () =>
          detectCodex(executable, undefined, storage.files.config),
        helperCommand: packagedHelper ?? electron ?? process.execPath,
        helperArgs:
          electron ?
            [
              ...(packagedHelper ? [] : [main]),
              '--connector-token',
              `--user-data-dir=${storage.directory}`,
            ]
          : [helper, storage.files.credential],
      })
      const connected = await service.connect({
        url: `http://127.0.0.1:${server.port}`,
        apiKey: credential,
      })
      expect(connected.model).toBe(model.slug)
      expect(connected.catalogMode).toBe('remote')
      expect(
        requests.filter((request) => request.path === '/models').length,
      ).toBeGreaterThanOrEqual(3)
      expect(
        requests.filter((request) => request.path === '/responses'),
      ).toHaveLength(2)
      expect(requests.every((request) => request.authenticated)).toBe(true)
      expect(storage.read('config')).not.toContain(credential)
      expect(storage.key()).toBe(credential)
      await service.undo()
      expect(storage.state()).toBeNull()
      expect(storage.read('config')).toBeNull()
    } finally {
      await server.stop(true)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
  180_000,
)
