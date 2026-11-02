import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  UsageRecord,
  UsageSummary,
  UsageTotals,
} from '@modelbridge/runtime/usage'
import type { AppStatus, CopilotQuotaStatus } from '../src/types'

const totals = (overrides: Partial<UsageTotals> = {}): UsageTotals => ({
  requests: 0,
  failed: 0,
  cancelled: 0,
  webSearches: 0,
  unreported: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  costedRequests: 0,
  costUsd: null,
  averageDurationMs: null,
  ...overrides,
})

test.skipIf(
  process.platform !== 'win32' || !process.env.MODELBRIDGE_TEST_ELECTRON,
)(
  'role chooser, role-specific tabs and the usage dashboard render recorded usage and quota',
  async () => {
    const electron = process.env.MODELBRIDGE_TEST_ELECTRON
    if (!electron) throw new Error('Set MODELBRIDGE_TEST_ELECTRON.')
    const renderer = path.resolve('out', 'renderer', 'index.html')
    const preload = path.resolve('out', 'preload', 'index.js')
    if (!fs.existsSync(renderer) || !fs.existsSync(preload))
      throw new Error('Build ModelBridge before dashboard UI tests.')
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'modelbridge-dashboard-'),
    )
    const status: AppStatus = {
      version: 'test',
      role: null,
      localUrl: 'http://127.0.0.1:4321/v1',
      sources: [],
      models: [],
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
    const copilot = {
      id: '00000000-0000-4000-8000-000000000001',
      label: 'Synthetic Copilot',
      kind: 'copilot',
      baseUrl: 'https://api.individual.githubcopilot.com',
      shared: true,
      models: [{ id: 'gpt-5.4', name: 'GPT 5.4', protocol: 'responses' }],
    }
    const now = Date.now()
    const record = (overrides: Partial<UsageRecord>): UsageRecord => ({
      at: now,
      sourceId: copilot.id,
      source: copilot.label,
      kind: 'copilot',
      model: 'gpt-5.4',
      access: 'local',
      purpose: 'request',
      status: 200,
      outcome: 'completed',
      durationMs: 1800,
      inputTokens: 42_000,
      cachedInputTokens: 30_000,
      cacheWriteTokens: 0,
      outputTokens: 1_200,
      reasoningTokens: 300,
      nanoAiu: 4_000_000_000,
      ...overrides,
    })
    const summaryTotals = totals({
      requests: 3,
      failed: 1,
      webSearches: 1,
      inputTokens: 84_000,
      cachedInputTokens: 60_000,
      outputTokens: 2_400,
      reasoningTokens: 600,
      totalTokens: 86_400,
      costedRequests: 2,
      costUsd: 0.08,
      averageDurationMs: 1800,
    })
    const summary = (range: string): UsageSummary => ({
      range: range as UsageSummary['range'],
      from: now - 6 * 86_400_000,
      to: now,
      totals: summaryTotals,
      models: [
        {
          ...summaryTotals,
          model: 'gpt-5.4',
          source: copilot.label,
          kind: 'copilot',
        },
      ],
      access: {
        local: totals({ requests: 2, totalTokens: 43_200 }),
        remote: totals({ requests: 1, totalTokens: 43_200 }),
      },
      daily: Array.from({ length: range === 'today' ? 1 : 7 }, (_, index) => {
        const date = new Date(now - (6 - index) * 86_400_000)
        return {
          date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
          ...(index % 2 ? summaryTotals : totals()),
        }
      }),
      recent: [
        record({ access: 'remote', purpose: 'web-search' }),
        record({
          outcome: 'failed',
          status: 500,
          inputTokens: 0,
          outputTokens: 0,
          nanoAiu: null,
        }),
        record({}),
      ],
    })
    const empty = (range: string): UsageSummary => ({
      ...summary(range),
      totals: totals(),
      models: [],
      daily: [],
      recent: [],
      access: { local: totals(), remote: totals() },
    })
    const quotas: CopilotQuotaStatus[] = [
      {
        sourceId: copilot.id,
        label: copilot.label,
        error: null,
        quota: {
          login: 'octocat',
          plan: 'individual_pro',
          resetDate: '2026-06-01',
          checkedAt: now,
          premium: {
            entitlement: 300,
            remaining: 120,
            percentRemaining: 40,
            unlimited: false,
            overageCount: 0,
            overagePermitted: false,
          },
          chat: {
            entitlement: null,
            remaining: null,
            percentRemaining: null,
            unlimited: true,
            overageCount: 0,
            overagePermitted: false,
          },
          completions: null,
        },
      },
    ]
    const fixture = path.join(directory, 'fixture.cjs')
    fs.writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({
        name: 'modelbridge-dashboard-test',
        main: 'fixture.cjs',
      }),
    )
    fs.writeFileSync(
      fixture,
      `
      const { app, BrowserWindow, ipcMain } = require('electron')
      const fs = require('node:fs')
      const [renderer, preload, initial, copilot, quotas, summaries, empties] = ${JSON.stringify(
        [
          renderer,
          preload,
          status,
          copilot,
          quotas,
          { today: summary('today'), '7d': summary('7d') },
          { today: empty('today'), '7d': empty('7d') },
        ],
      )}
      let status = initial
      let cleared = false
      const ranges = [], roles = []
      let quotaRequests = 0, refreshes = 0
      const success = value => ({ ok: true, value })
      ipcMain.handle('modelbridge:status', () => success(status))
      ipcMain.handle('modelbridge:set-role', (_event, role) => {
        roles.push(role)
        status = {...status, role, sources: role === 'host' ? [copilot] : status.sources}
        return success(status)
      })
      ipcMain.handle('modelbridge:usage', (_event, range) => {
        ranges.push(range)
        return success({ summary: (cleared ? empties : summaries)[range], error: null })
      })
      ipcMain.handle('modelbridge:usage-clear', () => { cleared = true; return success(empties.today) })
      ipcMain.handle('modelbridge:copilot-quota', (_event, refresh) => {
        quotaRequests++
        if (refresh) refreshes++
        return success(quotas)
      })
      ipcMain.handle('modelbridge:codex-status', () => success({
        configPath:'synthetic', effective:{provider:'openai',model:''},
        active:null, externalManagedEdit:false, revisions:[]
      }))
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
        const button = label => '[...document.querySelectorAll("button")].find(b => !b.closest("[hidden]") && b.textContent.trim() === ' + JSON.stringify(label) + ')'
        const click = async label => {
          await wait('!!' + button(label))
          await read('(() => { const b = ' + button(label) + '; if (b.disabled) throw new Error("Disabled: " + ' + JSON.stringify(label) + '); b.click() })()')
        }
        const text = selector => read('document.querySelector(' + JSON.stringify(selector) + ')?.innerText ?? ""')
        const tabs = () => read('[...document.querySelectorAll("[role=tab]")].map(t => t.textContent.trim().replace(/\\\\d+$/, ""))')
        const screenshot = async name => {
          const target = process.env.MODELBRIDGE_TEST_DASHBOARD_SCREENSHOTS
          if (!target) return
          window.show()
          await new Promise(resolve => setTimeout(resolve, 300))
          fs.writeFileSync(require('node:path').join(target, name + '.png'), (await window.webContents.capturePage()).toPNG())
        }

        await wait('!!' + button('Set up as host'))
        if (await read('!!document.querySelector("[role=tablist]")')) throw new Error('Tabs shown before a role was chosen')
        await screenshot('welcome')
        await click('Set up as host')
        await wait('document.querySelector("#tab-dashboard")?.getAttribute("aria-selected") === "true"')
        const hostTabs = JSON.stringify(await tabs())
        if (hostTabs !== JSON.stringify(['Dashboard','Host setup','Models','Codex','Settings'])) throw new Error('Host tabs: ' + hostTabs)

        await wait('document.querySelectorAll("#panel-dashboard .metric").length === 5')
        const metrics = await text('#panel-dashboard .metrics')
        for (const expected of ['REQUESTS', '3', '1 failed', '1 web search', '84K', '71% from cache', '$0.0800', '2 of 3 priced', '1.8 s'])
          if (!metrics.toUpperCase().includes(expected.toUpperCase())) throw new Error('Metric missing ' + expected + ': ' + metrics)
        await wait('(document.querySelector("#panel-dashboard .quota")?.innerText ?? "").includes("120 of 300 left")')
        const quota = await text('#panel-dashboard .quota')
        for (const expected of ['individual_pro', 'octocat', 'Unlimited', 'Resets'])
          if (!quota.includes(expected)) throw new Error('Quota missing ' + expected + ': ' + quota)
        if (await read('document.querySelectorAll("#panel-dashboard .chart .bar").length') !== 7) throw new Error('Expected seven daily bars')
        const recent = await text('#panel-dashboard section:last-of-type')
        for (const expected of ['Web search', 'remote', 'Failed (500)'])
          if (!recent.includes(expected)) throw new Error('Recent missing ' + expected + ': ' + recent)
        if (!(await text('#panel-dashboard')).includes('Remote clients')) throw new Error('Access split missing')
        await screenshot('dashboard-host')

        await click('Today')
        await wait('document.querySelectorAll("#panel-dashboard .chart .bar").length === 1')
        if (!(await read('JSON.stringify(' + button('Today') + '.getAttribute("aria-pressed"))')).includes('true')) throw new Error('Range not pressed')
        await click('Refresh quota')
        await wait('(' + button('Refresh quota') + ')?.disabled === false')

        await read('document.querySelector("#tab-settings").click()')
        await click('Clear usage history…')
        await click('Delete usage history')
        await wait('(document.querySelector("#panel-settings")?.innerText ?? "").includes("Usage history cleared.")')
        await read('document.querySelector("#tab-dashboard").click()')
        await wait('(document.querySelector("#panel-dashboard")?.innerText ?? "").includes("No requests in this range")')

        const before = quotaRequests
        await click('Client')
        await wait('JSON.stringify([...document.querySelectorAll("[role=tab]")].map(t => t.id)) === JSON.stringify(["tab-dashboard","tab-connect","tab-sources","tab-codex","tab-settings"])')
        if (await read('!!document.querySelector("#panel-dashboard .quota")')) throw new Error('Quota shown to a client')
        if (await read('!!document.querySelector("#panel-host")')) throw new Error('Host setup shown to a client')
        await new Promise(resolve => setTimeout(resolve, 200))
        if (quotaRequests !== before) throw new Error('Client fetched Copilot quota')
        await screenshot('dashboard-client')
        if (await read('!!document.querySelector("div.error[role=alert]")')) throw new Error(await text('div.error[role=alert]'))

        if (JSON.stringify(roles) !== JSON.stringify(['host','client'])) throw new Error('Roles: ' + JSON.stringify(roles))
        if (!ranges.includes('7d') || !ranges.includes('today')) throw new Error('Ranges: ' + JSON.stringify(ranges))
        if (refreshes !== 1) throw new Error('Quota refreshes: ' + refreshes)
        process.stdout.write('MODELBRIDGE_DASHBOARD_UI_OK\\n', () => app.quit())
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
      expect(stdout).toContain('MODELBRIDGE_DASHBOARD_UI_OK')
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
