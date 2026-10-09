import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { runCommand } from '../electron/connector/codex'

test.skipIf(
  !process.env.CONNECTOR_TEST_ELECTRON || process.platform !== 'win32',
)(
  'native credential helper uses the GUI encryption profile on first use and after restart',
  async () => {
    const electron = process.env.CONNECTOR_TEST_ELECTRON
    if (!electron) throw new Error('Set CONNECTOR_TEST_ELECTRON.')
    const main = path.resolve('out-connector', 'main', 'index.js')
    const helper = process.env.CONNECTOR_TEST_HELPER ?? electron
    if (!fs.existsSync(main)) throw new Error('Build the connector first.')
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'connector-storage-'),
    )
    const credential = 'synthetic-storage-lifecycle-key'
    const fixture = path.join(directory, 'gui-fixture.cjs')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODEX_HOME: path.join(directory, 'codex'),
    }
    delete env.ELECTRON_RUN_AS_NODE
    fs.writeFileSync(
      fixture,
      [
        "const { app, safeStorage } = require('electron')",
        "const fs = require('node:fs')",
        "const path = require('node:path')",
        "const { execFileSync, execSync, execFile } = require('node:child_process')",
        'const [main, root, helper, packaged, cached] = process.argv.slice(2)',
        "app.setPath('appData', root)",
        "app.setPath('userData', path.join(root, 'bootstrap-profile'))",
        "if (cached === 'true') app.getPath('sessionData')",
        'const loaded = new Promise(resolve => app.on("browser-window-created", (_event, window) => { window.hide(); window.webContents.once("did-finish-load", () => setImmediate(resolve)) }))',
        'require(main)',
        'app.whenReady().then(async () => {',
        'await loaded',
        "const directory = app.getPath('userData')",
        "const file = path.join(directory, 'gateway-key.encrypted')",
        'fs.mkdirSync(directory, { recursive: true })',
        `const credential = ${JSON.stringify(credential)}`,
        'if (!fs.existsSync(file)) fs.writeFileSync(file, safeStorage.encryptString(credential).toString("base64"))',
        'const result = { sameProfile: app.getPath("sessionData") === directory, guiDecrypted: false, helperDecrypted: false, profilesDecrypted: false, shellHelpersDecrypted: false }',
        'try {',
        'const stateFile = path.join(directory, "connection.json")',
        'const connection = { harness:"codex", baseUrl:"https://synthetic.example", model:"fixture-model", modelCount:1, catalogMode:"remote", verifiedAt:new Date().toISOString(), configPath:path.join(process.env.CODEX_HOME, "config.toml") }',
        'fs.writeFileSync(stateFile, JSON.stringify({version:1, originalConfig:null, fingerprint:"a".repeat(64), connection}))',
        'const renderer = require("electron").BrowserWindow.getAllWindows()[0].webContents',
        'const revealed = await renderer.executeJavaScript("window.connectorAPI.revealKey(\'codex\')")',
        'result.guiRevealed = revealed.ok && revealed.value === credential',
        'const invalid = await renderer.executeJavaScript("window.connectorAPI.revealKey(\'invalid-harness\')")',
        'result.invalidRevealRejected = !invalid.ok && invalid.error === "Invalid connector harness."',
        'result.repairBridgeReady = await renderer.executeJavaScript("typeof window.connectorAPI.repair === \'function\'")',
        'result.guiDecrypted = safeStorage.decryptString(Buffer.from(fs.readFileSync(file, "utf8"), "base64")) === credential',
        'const args = [...(packaged === "true" ? [] : [main]), "--connector-token", `--user-data-dir=${directory}`]',
        'result.helperDecrypted = execFileSync(helper, args, { encoding: "utf8", timeout: 30000 }).trim() === credential',
        'const harnesses = ["claude-code", "hermes", "openclaw", "opencode"]',
        'const profileKeys = harnesses.map(harness => `${credential}-${harness}`)',
        'const results = harnesses.map((harness, index) => {',
        'const profile = path.join(directory, "connections", harness)',
        'fs.mkdirSync(profile, { recursive: true })',
        'fs.writeFileSync(path.join(profile, "gateway-key.encrypted"), safeStorage.encryptString(profileKeys[index]).toString("base64"))',
        'const scoped = [...args, `--connector-harness=${harness}`]',
        'return execFileSync(helper, scoped, { encoding: "utf8", timeout: 30000 }).trim() === profileKeys[index]',
        '})',
        'result.profilesDecrypted = results.every(Boolean)',
        'const shellResults = ["claude-code", "hermes"].map(harness => {',
        'const scoped = [helper, ...args, `--connector-harness=${harness}`].map(value => `"${value}"`).join(" ")',
        'return execSync(scoped, { encoding: "utf8", timeout: 30000 }).trim() === `${credential}-${harness}`',
        '})',
        'result.shellHelpersDecrypted = shellResults.every(Boolean)',
        'const request = JSON.stringify({protocolVersion:1, provider:"copilot_api_connector", ids:["gateway-api-key"]})',
        'const passEnv = ["APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "WAYLAND_DISPLAY"]',
        'const restrictedEnv = Object.fromEntries(passEnv.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]))',
        'const secretArgs = [...(packaged === "true" ? [] : [main]), "--connector-openclaw-secret", "--connector-harness=openclaw", `--user-data-dir=${directory}`]',
        'const secretOutput = await new Promise((resolve, reject) => { const child = execFile(helper, secretArgs, {env:restrictedEnv, encoding:"utf8", timeout:30000}, (error, stdout) => error ? reject(error) : resolve(stdout)); child.stdin.end(request) })',
        'result.secretResolved = JSON.parse(secretOutput) === `${credential}-openclaw`',
        '} catch (error) { result.error = error.message }',
        'process.stdout.write(`CONNECTOR_STORAGE_RESULT:${JSON.stringify(result)}\\n`, () => app.quit())',
        '}).catch(error => { process.stderr.write(error.message); app.exit(1) })',
      ].join('\n'),
    )
    try {
      for (const cached of [false, true]) {
        const root = path.join(directory, cached ? 'cached' : 'default')
        const userData = path.join(root, 'Copilot API Connector')
        for (let restart = 0; restart < 2; restart++) {
          const output = execFileSync(
            electron,
            [
              fixture,
              main,
              root,
              helper,
              String(!!process.env.CONNECTOR_TEST_HELPER),
              String(cached),
            ],
            { env, encoding: 'utf8', timeout: 60_000 },
          )
          const match = output.match(/CONNECTOR_STORAGE_RESULT:(.+)/u)
          if (!match)
            throw new Error('The native GUI fixture returned no result.')
          const result: unknown = JSON.parse(match[1])
          expect(result).toEqual({
            sameProfile: true,
            guiDecrypted: true,
            helperDecrypted: true,
            profilesDecrypted: true,
            shellHelpersDecrypted: true,
            secretResolved: true,
            guiRevealed: true,
            invalidRevealRejected: true,
            repairBridgeReady: true,
          })
          const args = [
            ...(process.env.CONNECTOR_TEST_HELPER ? [] : [main]),
            '--connector-token',
            `--user-data-dir=${userData}`,
          ]
          const results = await Promise.all(
            Array.from({ length: 3 }, () =>
              runCommand(helper, args, { env, timeout: 30_000 }),
            ),
          )
          expect(
            results.every(({ stdout }) => stdout.trim() === credential),
          ).toBe(true)
        }
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
  400_000,
)
