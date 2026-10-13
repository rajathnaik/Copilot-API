import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

test.skipIf(
  !process.env.MODELBRIDGE_TEST_ELECTRON || process.platform !== 'win32',
)(
  'fresh native ModelBridge profile serves authenticated inference and survives a full process restart',
  async () => {
    const electron = process.env.MODELBRIDGE_TEST_ELECTRON
    if (!electron) throw new Error('Set MODELBRIDGE_TEST_ELECTRON.')
    const main = path.resolve('out', 'main', 'index.js')
    if (!fs.existsSync(main))
      throw new Error('Build ModelBridge before native tests.')
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'modelbridge-native-'),
    )
    const sourceKey = 'synthetic-native-provider-key'
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (request.headers.get('authorization') !== `Bearer ${sourceKey}`)
          return new Response('unauthorized', { status: 401 })
        if (new URL(request.url).pathname === '/v1/models')
          return Response.json({ data: [{ id: 'synthetic-native-model' }] })
        const body: unknown = await request.json()
        if (
          !body
          || typeof body !== 'object'
          || !('model' in body)
          || body.model !== 'synthetic-native-model'
        )
          return new Response('wrong model', { status: 400 })
        return new Response('data: {"output":"NATIVE_MODELBRIDGE_OK"}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    const fixture = path.join(directory, 'fixture.js')
    const codexHome = path.join(directory, 'codex-home')
    fs.mkdirSync(codexHome)
    fs.writeFileSync(
      path.join(codexHome, 'config.toml'),
      '# Isolated native settings\nweb_search = "disabled"\n',
    )
    fs.writeFileSync(
      path.join(codexHome, 'auth.json'),
      '{"OPENAI_API_KEY":"synthetic-native-account"}',
    )
    const desktop: unknown = JSON.parse(
      fs.readFileSync(path.resolve('package.json'), 'utf8'),
    )
    if (
      !desktop
      || typeof desktop !== 'object'
      || !('version' in desktop)
      || typeof desktop.version !== 'string'
    )
      throw new Error('ModelBridge package version is missing.')
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name: 'modelbridge-profile-test',
        version: desktop.version,
        main: 'fixture.js',
      }),
    )
    fs.writeFileSync(
      fixture,
      `
      const { app, dialog } = require('electron')
      const fs = require('node:fs')
      const path = require('node:path')
      const crypto = require('node:crypto')
      const [main, appPath, profile, endpoint, sourceKey] = ${JSON.stringify([main, process.cwd(), path.join(directory, 'profile'), `http://127.0.0.1:${upstream.port}/v1`, sourceKey])}
      const diagnostic = path.join(path.dirname(profile), 'native-error.txt')
      dialog.showErrorBox = (_title, message) => fs.writeFileSync(diagnostic, message)
      process.on('uncaughtException', error => { fs.writeFileSync(diagnostic, error.stack || error.message); app.exit(1) })
      app.setAppPath(appPath)
      app.commandLine.appendSwitch('user-data-dir', profile)
      const loaded = new Promise(resolve => app.on('browser-window-created', (_event, window) => {
        window.hide()
        window.webContents.once('did-finish-load', () => setImmediate(() => resolve(window)))
      }))
      require(main)
      loaded.then(async window => {
        const invoke = async expression => {
          const result = await window.webContents.executeJavaScript(expression)
          if (!result.ok) throw new Error(result.error)
          return result.value
        }
        let status = await invoke('window.modelbridge.status()')
        const fresh = status.sources.length === 0
        if (fresh) status = await invoke('window.modelbridge.addSource(' + JSON.stringify({
          label: 'Synthetic API', kind:'api', baseUrl:endpoint, protocol:'responses', apiKey:sourceKey, shared:false
        }) + ')')
        const key = await invoke('window.modelbridge.localKey()')
        const health = await fetch(status.localUrl.replace(/\\/v1$/, '/health'), {headers:{Authorization:'Bearer '+key}})
        const unauthorized = await fetch(status.localUrl + '/models')
        const response = await fetch(status.localUrl + '/responses', {
          method:'POST', headers:{Authorization:'Bearer '+key, 'Content-Type':'application/json'},
          body:JSON.stringify({model:status.models[0].id, stream:true})
        })
        const output = await response.text()
        let codexWorkflow = false
        if (process.env.MODELBRIDGE_TEST_CODEX) {
          const configPath = path.join(process.env.CODEX_HOME, 'config.toml')
          const accountPath = path.join(process.env.CODEX_HOME, 'auth.json')
          const nativeConfig = fs.readFileSync(configPath, 'utf8')
          const nativeAccount = fs.readFileSync(accountPath, 'utf8')
          const clickButton = async name => {
            await window.webContents.executeJavaScript(
              '(() => { const button = [...document.querySelectorAll("button")].find(item => item.textContent.trim() === ' + JSON.stringify(name) + '); if (!button || button.disabled) throw new Error("UI button unavailable: " + ' + JSON.stringify(name) + '); button.click(); })()')
          }
          const waitUI = async expression => {
            const deadline = Date.now() + 20000
            while (!await window.webContents.executeJavaScript(expression)) {
              const failure = await window.webContents.executeJavaScript('document.querySelector("div.error[role=alert]")?.textContent')
              if (failure) throw new Error('ModelBridge UI: ' + failure)
              if (Date.now() > deadline) throw new Error('UI did not reach expected state: ' + expression)
              await new Promise(resolve => setTimeout(resolve, 100))
            }
          }
          await clickButton('Discover installed Codex')
          await waitUI('[...document.querySelectorAll("button")].some(item => item.textContent.trim() === "Preview exact Codex changes" && !item.disabled)')
          await clickButton('Preview exact Codex changes')
          await waitUI('!!document.querySelector(".preview pre")')
          if (fs.readFileSync(configPath, 'utf8') !== nativeConfig) throw new Error('Preview altered Codex before approval.')
          if (process.env.MODELBRIDGE_TEST_SCREENSHOT && fresh) {
            await window.webContents.executeJavaScript('document.querySelector(".preview").scrollIntoView({block:"start"})')
            const image = await window.webContents.capturePage()
            fs.writeFileSync(process.env.MODELBRIDGE_TEST_SCREENSHOT, image.toPNG())
          }
          await clickButton('Apply reviewed changes and save revision')
          await waitUI('!document.querySelector(".preview")')
          const applied = await invoke('window.modelbridge.codexStatus()')
          if (applied.effective.provider !== 'modelbridge' || !applied.active) throw new Error('Reviewed configuration did not activate.')
          const configured = fs.readFileSync(configPath, 'utf8')
          if (configured.includes(key) || configured.includes(sourceKey)) throw new Error('Codex configuration contains a bearer secret.')
          const revision = await invoke('window.modelbridge.previewCodexRevision(' + JSON.stringify(applied.active) + ')')
          await invoke('window.modelbridge.applyCodex(' + JSON.stringify(revision.id) + ')')
          await clickButton('Preview restoration of original settings')
          await waitUI('!!document.querySelector(".preview pre")')
          await clickButton('Apply reviewed changes and save revision')
          await waitUI('!document.querySelector(".preview")')
          const restored = await invoke('window.modelbridge.codexStatus()')
          if (restored.active !== null || restored.effective.provider !== 'openai (default)') throw new Error('Native settings were not restored.')
          if (fs.readFileSync(accountPath, 'utf8') !== nativeAccount) throw new Error('Native account fixture was modified.')
          if (!fs.readFileSync(configPath, 'utf8').includes('web_search = "disabled"')) throw new Error('Unrelated native settings were changed.')
          codexWorkflow = true
        }
        const encrypted = fs.readFileSync(path.join(profile, 'credentials.encrypted.json'),'utf8')
        if (process.env.MODELBRIDGE_TEST_SCREENSHOT && !process.env.MODELBRIDGE_TEST_CODEX) {
          await new Promise(resolve => setTimeout(resolve, 2500))
          const image = await window.webContents.capturePage()
          fs.writeFileSync(process.env.MODELBRIDGE_TEST_SCREENSHOT, image.toPNG())
        }
        const result = {fresh, codexWorkflow, version:status.version, sources:status.sources.length,
          health:health.status, unauthorized:unauthorized.status, inference:response.status,
          reply:output.includes('NATIVE_MODELBRIDGE_OK'),
          encrypted:!encrypted.includes(sourceKey) && !encrypted.includes(key),
          keyHash:crypto.createHash('sha256').update(key).digest('hex'),
          legacyBridge:await window.webContents.executeJavaScript('typeof window.connectorAPI'),
          legacyUi:await window.webContents.executeJavaScript('typeof window.electronAPI')}
        process.stdout.write('MODELBRIDGE_RESULT:'+JSON.stringify(result)+'\\n', () => app.quit())
      }).catch(error => { console.error(error.message); app.exit(1) })
    `,
    )
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MODELBRIDGE_PORT: '0',
      CODEX_HOME: codexHome,
    }
    delete env.ELECTRON_RUN_AS_NODE
    try {
      let previousHash: string | undefined
      const syntax = Bun.spawnSync({ cmd: ['node', '--check', fixture] })
      expect(syntax.exitCode, new TextDecoder().decode(syntax.stderr)).toBe(0)
      for (let restart = 0; restart < 2; restart++) {
        const child = Bun.spawn({
          cmd: [
            electron,
            directory,
            `--user-data-dir=${path.join(directory, 'profile')}`,
          ],
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const timeout = setTimeout(() => child.kill(), 60_000)
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ])
        clearTimeout(timeout)
        const diagnostic = path.join(directory, 'native-error.txt')
        const failure =
          fs.existsSync(diagnostic) ?
            fs.readFileSync(diagnostic, 'utf8')
          : `${stdout}\n${stderr}`
        expect(code, failure).toBe(0)
        const match = /MODELBRIDGE_RESULT:(.+)/u.exec(stdout)
        if (!match) throw new Error('Native profile test returned no result.')
        const value: unknown = JSON.parse(match[1])
        if (
          !value
          || typeof value !== 'object'
          || !('keyHash' in value)
          || typeof value.keyHash !== 'string'
        )
          throw new Error('Native profile result is invalid.')
        expect(value).toMatchObject({
          fresh: restart === 0,
          codexWorkflow: !!process.env.MODELBRIDGE_TEST_CODEX,
          version: '0.1.0-dev.0',
          sources: 1,
          health: 200,
          unauthorized: 401,
          inference: 200,
          reply: true,
          encrypted: true,
          legacyBridge: 'undefined',
          legacyUi: 'undefined',
        })
        if (previousHash) expect(value.keyHash).toBe(previousHash)
        previousHash = value.keyHash
      }
      if (!previousHash)
        throw new Error('Native profile did not return a stable key hash.')
      const helper = Bun.spawn({
        cmd: [
          electron,
          process.cwd(),
          '--modelbridge-credential',
          `--user-data-dir=${path.join(directory, 'profile')}`,
        ],
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const helperTimeout = setTimeout(() => helper.kill(), 30_000)
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(helper.stdout).text(),
          new Response(helper.stderr).text(),
          helper.exited,
        ])
        expect(code, stderr).toBe(0)
        expect(createHash('sha256').update(stdout.trim()).digest('hex')).toBe(
          previousHash,
        )
      } finally {
        clearTimeout(helperTimeout)
        if (helper.exitCode === null) {
          helper.kill()
          await helper.exited
        }
      }
    } finally {
      await upstream.stop(true)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
  120_000,
)
