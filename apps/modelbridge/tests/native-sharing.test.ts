import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test.skipIf(
  process.platform !== 'win32' || !process.env.MODELBRIDGE_TEST_ELECTRON,
)(
  'native remote sharing verifies host readiness, model selection UI and enforced remote access',
  async () => {
    const electron = process.env.MODELBRIDGE_TEST_ELECTRON
    if (!electron) throw new Error('Set MODELBRIDGE_TEST_ELECTRON.')
    const main = path.resolve('out', 'main', 'index.js')
    if (!fs.existsSync(main))
      throw new Error('Build ModelBridge before native tests.')
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'modelbridge-sharing-'),
    )
    const profile = path.join(directory, 'profile')
    const cli = path.join(directory, 'devtunnel.exe')
    fs.writeFileSync(cli, 'synthetic CLI; never executed')
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (
          request.headers.get('authorization')
          !== 'Bearer synthetic-sharing-key'
        )
          return new Response('unauthorized', { status: 401 })
        if (new URL(request.url).pathname === '/v1/models')
          return Response.json({
            data: [{ id: 'sharing-model' }, { id: 'private-model' }],
          })
        const body: unknown = await request.json()
        return Response.json({
          output: 'SYNTHETIC_SHARING_OK',
          request: body,
        })
      },
    })
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name: 'modelbridge-sharing-test',
        main: 'fixture.cjs',
      }),
    )
    fs.writeFileSync(
      path.join(directory, 'fixture.cjs'),
      `
      const { app, dialog } = require('electron')
      const fs = require('node:fs')
      const path = require('node:path')
      const cp = require('node:child_process')
      const { EventEmitter } = require('node:events')
      const { PassThrough } = require('node:stream')
      const http = require('node:http')
      const listen = http.Server.prototype.listen
      let sharingPort = 0
      http.Server.prototype.listen = function(port, ...args) {
        if (port === 4322) {
          port = 0
          this.once('listening', () => { sharingPort = this.address().port })
        }
        return listen.call(this, port, ...args)
      }
      const [main, appPath, profile, cli, endpoint] = ${JSON.stringify([main, process.cwd(), profile, cli, `http://127.0.0.1:${upstream.port}/v1`])}
      const diagnostic = path.join(path.dirname(profile), 'failure.txt')
      dialog.showErrorBox = (_title, message) => fs.writeFileSync(diagnostic, message)
      const calls = []
      let attempts = 0, kills = 0
      cp.execFile = (file, args, options, callback) => {
        const child = new EventEmitter()
        if (path.basename(file).toLowerCase() === 'powershell.exe') {
          setImmediate(() => callback(null, '', ''))
          return child
        }
        if (file !== cli) throw new Error('Unexpected executable in isolated test: ' + file)
        calls.push(args)
        let output
        if (args.join(' ') === 'user show') output = 'Logged in as synthetic-user using GitHub.'
        else if (args[0] === 'show') output = JSON.stringify({tunnel:{
          tunnelId:args[1], ports:[{portNumber:sharingPort,protocol:'http'},{portNumber:9000}],
          accessControl:[{type:'Anonymous',scopes:['connect']}]
        }})
        else throw new Error('Unexpected tunnel command: ' + args[0])
        setImmediate(() => callback(null, output, ''))
        return child
      }
      cp.spawn = (file, args) => {
        if (file !== cli || args[0] !== 'host') throw new Error('Unexpected host executable.')
        calls.push(args)
        attempts++
        const child = Object.assign(new EventEmitter(), {
          stdout:new PassThrough(), stderr:new PassThrough(), exitCode:null,
          kill() { kills++; this.exitCode = 0; this.emit('close',0); return true }
        })
        const output = attempts === 1 ?
          'Hosting port ' + sharingPort + ' at https://invalid.example/\\nReady to accept connections\\n' :
          'Hosting port 9000 at https://synthetic-9000.euw.devtunnels.ms/\\nHosting port ' + sharingPort + ' at https://synthetic.euw.devtunnels.ms:' + sharingPort + '/, https://synthetic-' + sharingPort + '.euw.devtunnels.ms/ and inspect it at https://synthetic-' + sharingPort + '-inspect.euw.devtunnels.ms/\\nReady to accept connections\\n'
        setTimeout(() => child.stdout.emit('data', Buffer.from(output)), 50)
        return child
      }
      app.setAppPath(appPath)
      app.commandLine.appendSwitch('user-data-dir', profile)
      const loaded = new Promise(resolve => app.on('browser-window-created', (_event, window) => {
        window.hide()
        window.webContents.once('did-finish-load', () => resolve(window))
      }))
      require(main)
      loaded.then(async window => {
        const invoke = async expression => {
          const result = await window.webContents.executeJavaScript(expression)
          if (!result.ok) throw new Error(result.error)
          return result.value
        }
        const read = expression => window.webContents.executeJavaScript(expression)
        const wait = async expression => {
          const deadline = Date.now() + 12000
          while (!await read(expression)) {
            if (Date.now() > deadline) throw new Error('Missing sharing UI state: ' + expression)
            await new Promise(resolve => setTimeout(resolve, 50))
          }
        }
        const source = {label:'Shared synthetic source',kind:'api',baseUrl:endpoint,
          protocol:'responses',apiKey:'synthetic-sharing-key',shared:true}
        await invoke('window.modelbridge.addSource(' + JSON.stringify(source) + ')')
        await invoke('window.modelbridge.addSource(' + JSON.stringify({...source,label:'Private source',shared:false}) + ')')
        const failure = await window.webContents.executeJavaScript('window.modelbridge.startSharing()')
        if (failure.ok || !failure.error.includes('invalid Dev Tunnels URL'))
          throw new Error('Expected invalid host URL rejection, received: ' + JSON.stringify(failure))
        let status = await invoke('window.modelbridge.status()')
        if (status.sharing || status.remoteUrl) throw new Error('Failed host claimed sharing readiness')
        const stopped = await fetch('http://127.0.0.1:' + sharingPort + '/v1/models').then(() => false, () => true)
        if (!stopped) throw new Error('Failed startup left the sharing listener running')
        status = await invoke('window.modelbridge.startSharing()')
        if (!status.sharing || status.remoteUrl !== 'https://synthetic-' + sharingPort + '.euw.devtunnels.ms')
          throw new Error('Sharing did not use the CLI-issued sharing-port URL')
        const key = await invoke('window.modelbridge.remoteKey()')
        const localKey = await invoke('window.modelbridge.localKey()')
        const base = 'http://127.0.0.1:' + sharingPort + '/v1'
        const unauthorized = await fetch(base + '/models')
        if (unauthorized.status !== 401) throw new Error('Sharing accepted an unauthenticated request')
        const wrongKey = await fetch(base + '/models',{headers:{Authorization:'Bearer '+localKey}})
        if (wrongKey.status !== 401) throw new Error('Sharing accepted the local-only key')
        const headers = {Authorization:'Bearer '+key,'Content-Type':'application/json'}
        let catalogResponse = await fetch(base + '/models',{headers})
        let catalog = await catalogResponse.json()
        if (catalogResponse.status !== 200 || catalog.data.length !== 2) throw new Error('Sharing did not enforce source visibility')
        await wait('!!document.querySelector("#tab-sources")')
        await read('document.querySelector("#tab-sources").click()')
        await wait('!!document.querySelector(".model-sharing")')
        await read('document.querySelector(".model-sharing").open = true')
        const summary = 'document.querySelector(".model-sharing summary").textContent'
        const ready = '!document.querySelector(".model-sharing select").disabled'
        const selectMode = value => read('(() => {const s = document.querySelector(".model-sharing select"); s.value = ' + JSON.stringify(value) + '; s.dispatchEvent(new Event("change",{bubbles:true}))})()')
        await selectMode('selected')
        await wait('!!document.querySelector(".model-sharing-list") && ' + ready)
        const clickAction = label => read('[...document.querySelectorAll(".model-sharing button")].find(b => b.textContent.trim() === ' + JSON.stringify(label) + ').click()')
        await clickAction('Clear selection')
        await wait(summary + '.includes("0 of 2 shared") && ' + ready)
        if ((await (await fetch(base + '/models',{headers})).json()).data.length !== 0)
          throw new Error('Clear selection still exposed models')
        await clickAction('Select all models')
        await wait(summary + '.includes("2 of 2 shared") && ' + ready)
        await read('[...document.querySelectorAll(".model-sharing-list label")].find(label => label.textContent.includes("private-model")).querySelector("input").click()')
        await wait(summary + '.includes("1 of 2 shared") && ' + ready)
        status = await invoke('window.modelbridge.status()')
        const sharedSource = status.sources.find(source => source.shared)
        if (sharedSource.sharedModelIds.join(',') !== 'sharing-model') throw new Error('Renderer selection did not reach typed IPC')
        const invalid = await read('window.modelbridge.shareSource(' + JSON.stringify(sharedSource.id) + ',true,["unknown"])')
        if (invalid.ok || !invalid.error.includes('available models')) throw new Error('Invalid sharing input did not fail explicitly')
        catalogResponse = await fetch(base + '/models',{headers})
        catalog = await catalogResponse.json()
        if (catalog.data.length !== 1 || catalog.data[0].id !== sharedSource.id + '/sharing-model')
          throw new Error('Sharing catalog did not filter the selected models')
        const nativeCatalog = await (await fetch(base + '/codex/models',{headers})).json()
        if (nativeCatalog.models.length !== 1 || nativeCatalog.models[0].slug !== catalog.data[0].id)
          throw new Error('Codex catalog bypassed model selection')
        const denied = await fetch(base + '/responses',{method:'POST',headers,
          body:JSON.stringify({model:sharedSource.id + '/private-model',input:'Must not forward'})})
        if (denied.status !== 404) throw new Error('Guessed hidden model ID bypassed the policy')
        const localCatalog = await (await fetch(status.localUrl + '/models',{headers:{Authorization:'Bearer '+localKey}})).json()
        if (localCatalog.data.length !== 4) throw new Error('Remote model restrictions incorrectly limited local access')
        const response = await fetch(base + '/responses',{method:'POST',headers,
          body:JSON.stringify({model:catalog.data[0].id,input:'Synthetic inference'})})
        if (response.status !== 200 || !(await response.text()).includes('SYNTHETIC_SHARING_OK'))
          throw new Error('Sharing did not forward authenticated inference')
        await selectMode('all')
        await wait(summary + '.includes("2 of 2 shared") && ' + ready)
        status = await invoke('window.modelbridge.status()')
        if (status.sources.find(source => source.shared).sharedModelIds !== undefined)
          throw new Error('All-model mode did not clear the saved selection')
        status = await invoke('window.modelbridge.stopSharing()')
        if (status.sharing || status.remoteUrl || attempts !== 2 || kills !== 2)
          throw new Error('Host stop or failed-start cleanup did not complete')
        if (calls.some(args => args.includes('delete') || args.includes('create')))
          throw new Error('Existing owned tunnel was unexpectedly modified')
        process.stdout.write('MODELBRIDGE_SHARING_OK\\n', () => app.quit())
      }).catch(error => { console.error(error.stack || error.message); app.exit(1) })
    `,
    )
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MODELBRIDGE_PORT: '0',
      CODEX_HOME: path.join(directory, 'codex-home'),
    }
    for (const key of Object.keys(env))
      if (key.toLowerCase() === 'path') delete env[key]
    env.PATH = directory
    delete env.ELECTRON_RUN_AS_NODE
    const child = Bun.spawn({
      cmd: [electron, directory, `--user-data-dir=${profile}`],
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
      const diagnostic = path.join(directory, 'failure.txt')
      const failure =
        fs.existsSync(diagnostic) ?
          fs.readFileSync(diagnostic, 'utf8')
        : `${stdout}\n${stderr}`
      expect(code, failure).toBe(0)
      expect(stdout).toContain('MODELBRIDGE_SHARING_OK')
    } finally {
      clearTimeout(timeout)
      if (child.exitCode === null) {
        child.kill()
        await child.exited
      }
      await upstream.stop(true)
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
