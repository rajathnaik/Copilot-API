import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { SourceService } from '@modelbridge/runtime'
import { AppState } from '../electron/state'
import { windowsCredentialCodec } from '../electron/windows-credentials'

test.skipIf(
  process.platform !== 'win32' || !process.env.MODELBRIDGE_TEST_PACKAGED_EXE,
)(
  'packaged ModelBridge starts independently of workspace dependencies and serves its protected command key while running',
  async () => {
    const executable = process.env.MODELBRIDGE_TEST_PACKAGED_EXE
    if (!executable) throw new Error('Set MODELBRIDGE_TEST_PACKAGED_EXE.')
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'modelbridge-packaged-'),
    )
    const profile = path.join(directory, 'profile')
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (
          request.headers.get('authorization')
          !== 'Bearer synthetic-packaged-provider'
        )
          return new Response('unauthorized', { status: 401 })
        if (new URL(request.url).pathname === '/v1/models')
          return Response.json({ data: [{ id: 'packaged-model' }] })
        const body: unknown = await request.json()
        if (
          !body
          || typeof body !== 'object'
          || !('model' in body)
          || body.model !== 'packaged-model'
        )
          return new Response('wrong route', { status: 400 })
        return Response.json({ output: 'PACKAGED_MODELBRIDGE_OK' })
      },
    })
    const reservation = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response('reserved'),
    })
    const port = reservation.port
    await reservation.stop(true)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MODELBRIDGE_PORT: String(port),
      CODEX_HOME: path.join(directory, 'codex-home'),
    }
    delete env.ELECTRON_RUN_AS_NODE
    const codec = windowsCredentialCodec(profile, {
      encrypt: () => {
        throw new Error('Unexpected legacy encryption')
      },
      decrypt: () => {
        throw new Error('Unexpected legacy credential')
      },
    })
    const state = new AppState(profile, codec)
    const sources = new SourceService([], state.vault, (next) =>
      state.save({ ...state.value, sources: next }),
    )
    let child: ReturnType<typeof Bun.spawn> | undefined
    try {
      await sources.add({
        label: 'Synthetic packaged provider',
        kind: 'api',
        baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
        protocol: 'responses',
        apiKey: 'synthetic-packaged-provider',
        shared: false,
      })
      const key = state.vault.get('local-access')
      const headers = { Authorization: `Bearer ${key}` }
      child = Bun.spawn({
        cmd: [executable, `--user-data-dir=${profile}`],
        cwd: directory,
        env,
        stdout: 'ignore',
        stderr: 'ignore',
      })
      const root = `http://127.0.0.1:${port}`
      const deadline = Date.now() + 30_000
      let ready = false
      while (Date.now() < deadline && child.exitCode === null) {
        try {
          const response = await fetch(`${root}/health`, {
            headers,
            signal: AbortSignal.timeout(1000),
          })
          expect(response.status).toBe(200)
          expect(await response.json()).toMatchObject({
            product: 'ModelBridge',
          })
          ready = true
          break
        } catch (error) {
          if (
            !(error instanceof TypeError)
            && !(error instanceof DOMException && error.name === 'TimeoutError')
          )
            throw error
          await Bun.sleep(100)
        }
      }
      expect(ready, 'Packaged ModelBridge did not become responsive.').toBe(
        true,
      )
      expect((await fetch(`${root}/v1/models`)).status).toBe(401)
      const inference = await fetch(`${root}/v1/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: sources.models()[0].id }),
      })
      expect(await inference.json()).toEqual({
        output: 'PACKAGED_MODELBRIDGE_OK',
      })
      const helper = Bun.spawn({
        cmd: [
          executable,
          '--modelbridge-credential',
          `--user-data-dir=${profile}`,
        ],
        cwd: directory,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const timer = setTimeout(() => helper.kill(), 30_000)
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(helper.stdout).text(),
          new Response(helper.stderr).text(),
          helper.exited,
        ])
        expect(code, stderr).toBe(0)
        expect(createHash('sha256').update(stdout.trim()).digest('hex')).toBe(
          createHash('sha256').update(key).digest('hex'),
        )
      } finally {
        clearTimeout(timer)
        if (helper.exitCode === null) {
          helper.kill()
          await helper.exited
        }
      }
      expect(
        fs.existsSync(path.join(path.dirname(executable), 'LICENSE')),
      ).toBe(true)
      expect(
        fs.existsSync(path.join(path.dirname(executable), 'NOTICE.md')),
      ).toBe(true)
    } finally {
      if (child && child.exitCode === null) {
        child.kill()
        await child.exited
      }
      await upstream.stop(true)
      await fs.promises.rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 500,
      })
    }
  },
  120_000,
)
