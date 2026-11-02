import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AppStatus } from '../src/types'

test.skipIf(
  process.platform !== 'win32' || !process.env.MODELBRIDGE_TEST_ELECTRON,
)(
  'host sign-in controls confirm verified accounts, wait for approval and support manual checks',
  async () => {
    const electron = process.env.MODELBRIDGE_TEST_ELECTRON
    if (!electron) throw new Error('Set MODELBRIDGE_TEST_ELECTRON.')
    const renderer = path.resolve('out', 'renderer', 'index.html')
    const preload = path.resolve('out', 'preload', 'index.js')
    if (!fs.existsSync(renderer) || !fs.existsSync(preload))
      throw new Error('Build ModelBridge before sign-in UI tests.')
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'modelbridge-signin-'),
    )
    const status: AppStatus = {
      version: 'test',
      role: 'host',
      localUrl: 'http://127.0.0.1:4321/v1',
      sources: [],
      models: [],
      sharing: false,
      remoteUrl: null,
      transportError: null,
      login: null,
      tunnelUser: null,
      tunnelUserChecking: true,
      tunnelSigningIn: false,
      tunnelAccountError: null,
      copilotLogin: null,
      copilotError: null,
    }
    const copilot = {
      id: '00000000-0000-4000-8000-000000000001',
      label: 'Synthetic Copilot',
      kind: 'copilot',
      baseUrl: 'https://api.individual.githubcopilot.com',
      shared: true,
      models: [{ id: 'test-model', name: 'Test model', protocol: 'responses' }],
    }
    const fixture = path.join(directory, 'fixture.cjs')
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({ name: 'modelbridge-signin-test', main: 'fixture.cjs' }),
    )
    fs.writeFileSync(
      fixture,
      `
      const { app, BrowserWindow, ipcMain } = require('electron')
      const fs = require('node:fs')
      const [renderer, preload, initial, copilot] = ${JSON.stringify([renderer, preload, status, copilot])}
      let status = initial
      let checks = 0, opened = 0
      const providers = []
      let verified = false, checkError = false
      const success = value => ({ ok: true, value })
      ipcMain.handle('modelbridge:status', () => success(status))
      ipcMain.handle('modelbridge:codex-status', () => success({
        configPath:'synthetic', effective:{provider:'openai',model:''},
        active:null, externalManagedEdit:false, revisions:[]
      }))
      ipcMain.handle('modelbridge:tunnel-login', (_event, provider) => {
        providers.push(provider)
        status = {...status, tunnelSigningIn:true, tunnelUser:null, login:null}
        return success(status)
      })
      ipcMain.handle('modelbridge:open-login', () => { opened++; return success() })
      ipcMain.handle('modelbridge:tunnel-check-login', () => {
        checks++
        if (checkError) {
          status = {...status, tunnelUser:null, tunnelAccountError:'Synthetic account-check failure'}
          return {ok:false, error:status.tunnelAccountError}
        }
        status = {...status, tunnelAccountError:null}
        if (verified) status = {...status, tunnelSigningIn:false, login:null,
          tunnelUser:{name:'synthetic-user',provider:'GitHub'}}
        return success(status)
      })
      ipcMain.handle('modelbridge:copilot-login', () => {
        status = {...status, copilotLogin:{url:'https://github.com/login/device',code:'TEST-1234'}}
        return success(status)
      })
      app.whenReady().then(async () => {
        const window = new BrowserWindow({show:false,width:1100,height:1000,webPreferences:{preload}})
        await window.loadFile(renderer)
        const read = expression => window.webContents.executeJavaScript(expression)
        const button = (label, section = 2) =>
          '[...document.querySelectorAll("#panel-host section:nth-of-type(' + section + ') button")].find(b => b.textContent.trim() === ' + JSON.stringify(label) + ')'
        const wait = async expression => {
          const deadline = Date.now() + 12000
          while (!await read(expression)) {
            if (Date.now() > deadline) throw new Error('Missing UI state: ' + expression)
            await new Promise(resolve => setTimeout(resolve, 50))
          }
        }
        const click = async (label, section = 2) => {
          await read('(() => { const b = ' + button(label, section) + '; if (!b || b.disabled) throw new Error("Unavailable: " + ' + JSON.stringify(label) + '); b.click() })()')
        }
        await wait('!!document.querySelector("#tab-host")')
        await read('document.querySelector("#tab-host").click()')
        await wait('!!' + button('Checking sign-in...'))
        if (!await read(button('Enable remote access') + '.disabled')) throw new Error('Sharing enabled before account check')
        status = {...status,tunnelUserChecking:false}
        await wait('!!' + button('Sign in with GitHub'))
        await click('Sign in with GitHub')
        await wait('!!' + button('Waiting for approval...'))
        if (!await read(button('Waiting for approval...') + '.disabled')) throw new Error('Duplicate login allowed')
        await click("I've signed in - check status")
        await wait('!!' + button('Waiting for approval...'))
        if (checks !== 1 || await read('!!' + button('Signed in'))) throw new Error('Manual check bypassed verification')
        status = {...status,login:{url:'https://github.com/login/device',code:'TEST-1234'}}
        await wait('!!' + button('Open sign-in page'))
        await click('Open sign-in page')
        if (opened !== 1) throw new Error('Sign-in link did not reach IPC')
        status = {...status,tunnelSigningIn:false,login:null,
          tunnelUser:{name:'synthetic-user',provider:'GitHub'}}
        await wait('!!' + button('Signed in'))
        if (!await read(button('Signed in') + '.disabled')) throw new Error('Signed-in control is not a confirmation')
        if (await read(button('Enable remote access') + '.disabled')) throw new Error('Verified account did not enable sharing')
        if (!await read('document.querySelector("#panel-host").innerText.includes("synthetic-user")')) throw new Error('Account identity not shown')
        status = {...status,sharing:true,tunnelUserChecking:true}
        await wait('!!' + button('Checking sign-in...'))
        if (await read(button('Stop sharing') + '.disabled')) throw new Error('Account check blocked stopping the tunnel')
        status = {...status,tunnelUserChecking:false}
        await wait('!!' + button('Switch to a GitHub account'))
        if (!await read(button('Switch to a GitHub account') + '.disabled')) throw new Error('Account switch allowed while sharing')
        status = {...status,sharing:false}
        status = {...status,tunnelUser:null}
        await wait('!!' + button('Sign in with Microsoft'))
        await click('Sign in with Microsoft')
        await wait('!!' + button('Waiting for approval...'))
        verified = true
        await click("I've signed in - check status")
        await wait('!!' + button('Signed in'))
        if (checks !== 2 || providers.join(',') !== 'github,microsoft') throw new Error('Provider or manual check IPC mismatch')
        checkError = true
        await click('Check sign-in status')
        await wait('document.querySelector("#panel-host").innerText.includes("Synthetic account-check failure")')
        if (await read('!!' + button('Signed in'))) throw new Error('Failed check displayed success')
        if (!await read(button('Enable remote access') + '.disabled')) throw new Error('Failed check enabled sharing')
        checkError = false
        await click('Check sign-in status')
        await wait('!!' + button('Signed in'))
        await click('Sign in and discover models', 1)
        await wait('!!' + button('Waiting for GitHub approval...', 1))
        status = {...status,copilotLogin:null,sources:[copilot]}
        await wait('!!' + button('Signed in', 1))
        if (!await read(button('Signed in', 1) + '.disabled')) throw new Error('Copilot sign-in not confirmed')
        await wait('!!' + button('Sign in again', 1))
        if (process.env.MODELBRIDGE_TEST_SIGNIN_SCREENSHOT) {
          window.show()
          await read('document.querySelector("#panel-host section:nth-of-type(2)").scrollIntoView({block:"start"})')
          await new Promise(resolve => setTimeout(resolve, 250))
          fs.writeFileSync(process.env.MODELBRIDGE_TEST_SIGNIN_SCREENSHOT, (await window.webContents.capturePage()).toPNG())
        }
        process.stdout.write('MODELBRIDGE_SIGNIN_UI_OK\\n', () => app.quit())
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
      expect(stdout).toContain('MODELBRIDGE_SIGNIN_UI_OK')
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
