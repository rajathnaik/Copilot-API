import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppStatus } from '../src/types'

test.skipIf(
  process.platform !== 'win32' || !process.env.MODELBRIDGE_TEST_ELECTRON,
)(
  'clients can check, edit and remove connected hosts, and see duplicates and Codex impact',
  async () => {
    const electron = process.env.MODELBRIDGE_TEST_ELECTRON
    if (!electron) throw new Error('Set MODELBRIDGE_TEST_ELECTRON.')
    const renderer = path.resolve('out', 'renderer', 'index.html')
    const preload = path.resolve('out', 'preload', 'index.js')
    if (!fs.existsSync(renderer) || !fs.existsSync(preload))
      throw new Error('Build ModelBridge before source UI tests.')
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'modelbridge-sources-'),
    )
    const host = (id: string) => ({
      id,
      label: 'Remote Copilot host',
      kind: 'remote',
      baseUrl: 'https://home-4322.euw.devtunnels.ms/v1',
      shared: false,
      models: [
        { id: 'gpt-5', name: 'GPT-5', protocol: 'responses' },
        { id: 'claude', name: 'Claude', protocol: 'responses' },
      ],
    })
    const first = '00000000-0000-4000-8000-00000000000a'
    const second = '00000000-0000-4000-8000-00000000000b'
    const sources = [host(first), host(second)]
    const status: AppStatus = {
      version: 'test',
      role: 'client',
      clientName: 'laptop',
      defaultClientName: 'laptop',
      localUrl: 'http://127.0.0.1:4321/v1',
      sources: sources as AppStatus['sources'],
      sourceHealth: {
        [first]: {
          ok: true,
          checkedAt: '2026-11-02T10:00:00.000Z',
          message: null,
        },
      },
      models: sources.flatMap((source) =>
        source.models.map((model) => ({
          ...model,
          id: `${source.id}/${model.id}`,
          sourceId: source.id,
          sourceLabel: source.label,
          protocol: 'responses' as const,
          protocols: ['responses' as const],
        })),
      ),
      sharing: false,
      remoteUrl: null,
      transportError: null,
      login: null,
      tunnelUser: null,
      tunnelUserChecking: false,
      tunnelSigningIn: false,
      tunnelAccountError: null,
      copilotLogin: null,
      copilotError: null,
    }
    const fixture = path.join(directory, 'fixture.cjs')
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: 'modelbridge-sources-test', main: 'fixture.cjs' }),
    )
    fs.writeFileSync(
      fixture,
      `
      const { app, BrowserWindow, ipcMain } = require('electron')
      const fs = require('node:fs')
      const path = require('node:path')
      const [renderer, preload, initial, first, second] = ${JSON.stringify([renderer, preload, status, first, second])}
      const screenshots = process.env.MODELBRIDGE_TEST_SOURCES_SCREENSHOTS
      let status = initial
      const calls = []
      let revisionPreviews = 0
      const success = value => ({ ok: true, value })
      const withSources = sources => ({...status, sources,
        models: status.models.filter(model => sources.some(source => model.sourceId === source.id))})
      ipcMain.handle('modelbridge:status', () => success(status))
      ipcMain.handle('modelbridge:usage', () => ({ ok:false, error:'Usage is not part of this test.' }))
      ipcMain.handle('modelbridge:codex-status', () => success({
        configPath:'synthetic', effective:{provider:'modelbridge',model:first + '/gpt-5'},
        active:'00000000-0000-4000-8000-0000000000c1', externalManagedEdit:false,
        catalogStale: status.sources.length === 1, missingModel:false, revisions:[]
      }))
      ipcMain.handle('modelbridge:codex-revision', () => {
        revisionPreviews++
        return success({ id:'00000000-0000-4000-8000-0000000000c2', label:'Remote Copilot',
          configPath:'synthetic', catalogPath:'synthetic.json', before:'', after:'model = "x"', changes:['Updated model list'] })
      })
      ipcMain.handle('modelbridge:refresh-source', (_event, id) => {
        calls.push(['refresh', id])
        status = {...status, sourceHealth:{...status.sourceHealth,
          [id]:{ok:false,checkedAt:'2026-11-02T10:05:00.000Z',message:'Source discovery returned HTTP 401. Check its credentials and availability.'}}}
        return success(status)
      })
      ipcMain.handle('modelbridge:update-source', (_event, input) => {
        calls.push(['update', input])
        if (input.apiKey === 'bad') return { ok:false, error:'Source discovery returned HTTP 401.' }
        status = withSources(status.sources.map(source => source.id === input.sourceId ? {...source, label:input.label} : source))
        return success(status)
      })
      ipcMain.handle('modelbridge:remove-source', (_event, id) => {
        calls.push(['remove', id])
        status = withSources(status.sources.filter(source => source.id !== id))
        return success(status)
      })
      app.whenReady().then(async () => {
        const window = new BrowserWindow({show:false,width:1100,height:1000,webPreferences:{preload}})
        await window.loadFile(renderer)
        const read = expression => window.webContents.executeJavaScript(expression)
        const wait = async expression => {
          const deadline = Date.now() + 12000
          while (!await read(expression)) {
            if (Date.now() > deadline) throw new Error('Missing UI state: ' + expression)
            await new Promise(resolve => setTimeout(resolve, 50))
          }
        }
        const card = id => 'document.querySelector(' + JSON.stringify('#panel-connect [data-source-id="' + id + '"]') + ')'
        const button = (scope, label) =>
          '[...' + scope + '.querySelectorAll("button")].find(b => b.textContent.trim() === ' + JSON.stringify(label) + ')'
        const click = async (scope, label) => {
          await wait('!!' + button(scope, label) + ' && !' + button(scope, label) + '.disabled')
          await read(button(scope, label) + '.click()')
        }
        const text = scope => read(scope + '.innerText')
        const capture = async name => {
          if (!screenshots) return
          window.show()
          await new Promise(resolve => setTimeout(resolve, 250))
          fs.writeFileSync(path.join(screenshots, name + '.png'), (await window.webContents.capturePage()).toPNG())
        }
        const panel = 'document.querySelector("#panel-connect")'
        await wait('!!document.querySelector("#tab-connect")')
        if ((await read('document.querySelector("#tab-connect").textContent')).trim() !== 'Hosts') throw new Error('Client tab is not named Hosts')
        await read('document.querySelector("#tab-connect").click()')
        await wait(card(first) + ' && ' + card(second))
        if (await read('!!' + panel + '.querySelector("form")')) throw new Error('Add form is open while hosts exist')
        const firstText = await text(card(first))
        if (!firstText.includes('Used by Codex') || !firstText.includes('Duplicate') || !firstText.includes('Connected'))
          throw new Error('First host badges missing: ' + firstText)
        if ((await text(card(second))).includes('Used by Codex')) throw new Error('Codex badge on the wrong host')
        await capture('sources-duplicates')

        await click(card(second), 'Check connection')
        await wait(card(second) + '.innerText.includes("Unreachable") && ' + card(second) + '.innerText.includes("HTTP 401")')

        await click(card(second), 'Edit')
        await wait('!!' + card(second) + '.querySelector("form")')
        const setField = (name, value) => read('(() => { const input = ' + card(second) + '.querySelector("[name=' + name + ']"); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; setter.call(input, ' + JSON.stringify(value) + '); input.dispatchEvent(new Event("input", {bubbles:true})) })()')
        await setField('label', 'Old laptop link')
        await setField('apiKey', 'bad')
        await click(card(second), 'Save changes')
        await wait(card(second) + '.innerText.includes("HTTP 401.")')
        if (!await read('!!' + card(second) + '.querySelector("form")')) throw new Error('Failed edit closed the form')
        if (await read('document.querySelector("main > .error")?.textContent.includes("401") ?? false')) throw new Error('Edit error shown in the page banner instead of inline')
        await setField('apiKey', '')
        await capture('sources-edit')
        await click(card(second), 'Save changes')
        await wait('!' + card(second) + '.querySelector("form") && ' + card(second) + '.innerText.includes("Old laptop link")')
        const update = calls.find(call => call[0] === 'update' && call[1].apiKey === undefined)
        if (!update || update[1].baseUrl !== 'https://home-4322.euw.devtunnels.ms/v1') throw new Error('Edit did not send typed update: ' + JSON.stringify(calls))

        await click(card(first), 'Remove…')
        await wait(card(first) + '.innerText.includes("Codex currently uses")')
        await capture('sources-remove')
        await click(card(first), 'Keep it')
        await wait('!' + card(first) + '.innerText.includes("Codex currently uses")')
        await click(card(second), 'Remove…')
        await wait(card(second) + '.innerText.includes("saved access key is deleted")')
        if ((await text(card(second))).includes('Codex currently uses')) throw new Error('Codex warning on unused host')
        await click(card(second), 'Remove')
        await wait('!' + card(second) + ' && !!' + card(first))
        if (calls.filter(call => call[0] === 'remove').map(call => call[1]).join() !== second) throw new Error('Wrong host removed')
        if ((await text(card(first))).includes('Duplicate')) throw new Error('Duplicate badge remained')

        await click(panel, 'Add a host')
        await wait('!!' + panel + '.querySelector("form [name=baseUrl]")')
        await click(panel, 'Cancel')
        await wait('!' + panel + '.querySelector("form")')

        await read('document.querySelector("#tab-codex").click()')
        await wait('document.querySelector("#panel-codex .codex-update")?.innerText.includes("out of date")')
        await click('document.querySelector("#panel-codex .codex-update")', 'Preview Codex update')
        await wait('!!document.querySelector("#panel-codex .preview")')
        if (revisionPreviews !== 1) throw new Error('Codex update did not preview the active revision')
        process.stdout.write('MODELBRIDGE_SOURCES_UI_OK\\n', () => app.quit())
      }).catch(error => { console.error(error.stack || error.message); app.exit(1) })
    `,
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
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
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code, `${stdout}\n${stderr}`).toBe(0)
      expect(stdout).toContain('MODELBRIDGE_SOURCES_UI_OK')
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null) {
        child.kill()
        await child.exited
      }
      fs.rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 30,
        retryDelay: 100,
      })
    }
  },
  75_000,
)
