import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test.skipIf(
  process.platform !== 'win32' || !process.env.MODELBRIDGE_TEST_ELECTRON,
)(
  'native remote sharing accepts URL-less metadata, reads host output and closes failed listeners',
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
          return Response.json({ data: [{ id: 'sharing-model' }] })
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
          tunnelId:args[1], ports:[{portNumber:4322,protocol:'http'},{portNumber:9000}],
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
          'Hosting port 4322 at https://invalid.example/\\nReady to accept connections\\n' :
          'Hosting port 9000 at https://synthetic-9000.euw.devtunnels.ms/\\nHosting port 4322 at https://synthetic.euw.devtunnels.ms:4322/, https://synthetic-4322.euw.devtunnels.ms/ and inspect it at https://synthetic-4322-inspect.euw.devtunnels.ms/\\nReady to accept connections\\n'
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
        const source = {label:'Shared synthetic source',kind:'api',baseUrl:endpoint,
          protocol:'responses',apiKey:'synthetic-sharing-key',shared:true}
        await invoke('window.modelbridge.addSource(' + JSON.stringify(source) + ')')
        await invoke('window.modelbridge.addSource(' + JSON.stringify({...source,label:'Private source',shared:false}) + ')')
        const failure = await window.webContents.executeJavaScript('window.modelbridge.startSharing()')
        if (failure.ok || !failure.error.includes('invalid Dev Tunnels URL')) throw new Error('Invalid host URL did not fail explicitly')
        let status = await invoke('window.modelbridge.status()')
        if (status.sharing || status.remoteUrl) throw new Error('Failed host claimed sharing readiness')
        const stopped = await fetch('http://127.0.0.1:4322/v1/models').then(() => false, () => true)
        if (!stopped) throw new Error('Failed startup left the sharing listener running')
        status = await invoke('window.modelbridge.startSharing()')
        if (!status.sharing || status.remoteUrl !== 'https://synthetic-4322.euw.devtunnels.ms')
          throw new Error('Sharing did not use the CLI-issued sharing-port URL')
        const key = await invoke('window.modelbridge.remoteKey()')
        const localKey = await invoke('window.modelbridge.localKey()')
        const base = 'http://127.0.0.1:4322/v1'
        const unauthorized = await fetch(base + '/models')
        if (unauthorized.status !== 401) throw new Error('Sharing accepted an unauthenticated request')
        const wrongKey = await fetch(base + '/models',{headers:{Authorization:'Bearer '+localKey}})
        if (wrongKey.status !== 401) throw new Error('Sharing accepted the local-only key')
        const headers = {Authorization:'Bearer '+key,'Content-Type':'application/json'}
        const catalogResponse = await fetch(base + '/models',{headers})
        const catalog = await catalogResponse.json()
        if (catalogResponse.status !== 200 || catalog.data.length !== 1) throw new Error('Sharing did not enforce source visibility')
        const response = await fetch(base + '/responses',{method:'POST',headers,
          body:JSON.stringify({model:catalog.data[0].id,input:'Synthetic inference'})})
        if (response.status !== 200 || !(await response.text()).includes('SYNTHETIC_SHARING_OK'))
          throw new Error('Sharing did not forward authenticated inference')
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
      PATH: directory,
      MODELBRIDGE_PORT: '0',
      CODEX_HOME: path.join(directory, 'codex-home'),
    }
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
