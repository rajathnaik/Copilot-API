import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  powerMonitor,
  Tray,
  shell,
} from 'electron'
import path from 'node:path'
import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'
import { z } from 'zod'
import {
  appHeader,
  createGateway,
  serve,
  SourceService,
} from '@modelbridge/runtime'
import {
  sharingInputSchema,
  sourceInputSchema,
  sourceUpdateSchema,
  copilotInputSchema,
  roleSchema,
  stateSchema,
  defaultTunnelHealthSettings,
  tunnelHealthSettingsSchema,
} from '@modelbridge/runtime/contracts'
import type { CopilotLogin } from '@modelbridge/runtime/copilot'
import { CodexConfigurations } from '@modelbridge/runtime/codex'
import {
  AppConfigurations,
  configurableAppSchema,
} from '@modelbridge/runtime/apps'
import { DevTunnels } from '@modelbridge/runtime/dev-tunnels'
import { CredentialStore } from '@modelbridge/runtime/credentials'
import { UsageLedger, usageRanges } from '@modelbridge/runtime/usage'
import {
  noPremiumLimits,
  premiumLimitStatus,
  premiumLimitsSchema,
} from '@modelbridge/runtime/limits'
import type {
  AppStatus,
  CopilotQuotaStatus,
  Result,
  SourceHealth,
} from '../src/types'
import { AppState, credentialsFile } from './state'
import { TunnelProcess } from './devtunnel-process'
import { TunnelWatchdog } from './tunnel-watchdog'
import { codexConfigPath, discoverCodex, inspectCodex } from './codex-discovery'
import { createDiagnosticsLog, describeError } from './diagnostics'
import {
  copyProfile,
  pointerFile,
  readDataLocation,
  validateDataTarget,
  writeDataLocation,
  writeDataRegistry,
} from './data-location'
import { downloadUpdate, findUpdate, type UpdateState } from './updates'

app.setName('ModelBridge')
app.setAppUserModelId('com.rajathnaik.modelbridge')
const override = app.commandLine.getSwitchValue('user-data-dir')
const installDir = path.dirname(process.execPath)
const defaultDataDir = path.join(app.getPath('appData'), 'ModelBridge')
app.setPath(
  'userData',
  override ? path.resolve(override)
  : app.isPackaged ? (readDataLocation(installDir) ?? defaultDataDir)
  : defaultDataDir,
)
app.setPath('sessionData', app.getPath('userData'))
const movedFrom =
  app.commandLine.getSwitchValue('modelbridge-moved-from') || null
// Runs after the runtime has stopped and before the process exits.
let afterShutdown: (() => Promise<void>) | null = null

let window: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let localServer: ReturnType<typeof serve> | null = null
let remoteServer: ReturnType<typeof serve> | null = null
let usageLedger: UsageLedger | null = null
const transport = new TunnelProcess()
let copilotController: AbortController | null = null
const credentialMode = process.argv.includes('--modelbridge-credential')
const diagnostics = createDiagnosticsLog(app.getPath('userData'))
const log = (event: string, detail?: string) => {
  if (!credentialMode) void diagnostics.write(event, detail)
}
const channels = [
  'modelbridge:status',
  'modelbridge:local-key',
  'modelbridge:remote-key',
  'modelbridge:copilot-login',
  'modelbridge:copilot-cancel',
  'modelbridge:open-login',
  'modelbridge:refresh-source',
  'modelbridge:codex-status',
  'modelbridge:codex-discover',
  'modelbridge:codex-select',
  'modelbridge:codex-preview',
  'modelbridge:codex-revision',
  'modelbridge:codex-restore',
  'modelbridge:codex-apply',
  'modelbridge:codex-reconcile',
  'modelbridge:add-source',
  'modelbridge:update-source',
  'modelbridge:remove-source',
  'modelbridge:share-source',
  'modelbridge:web-search-model',
  'modelbridge:tunnel-login',
  'modelbridge:tunnel-check-login',
  'modelbridge:sharing-start',
  'modelbridge:sharing-stop',
  'modelbridge:tunnel-check',
  'modelbridge:tunnel-settings',
  'modelbridge:set-role',
  'modelbridge:set-client-name',
  'modelbridge:usage',
  'modelbridge:premium-limits',
  'modelbridge:usage-clear',
  'modelbridge:copilot-quota',
  'modelbridge:playground-send',
  'modelbridge:playground-cancel',
  'modelbridge:copy-text',
  'modelbridge:copy-key',
  'modelbridge:app-config-status',
  'modelbridge:app-config-preview',
  'modelbridge:app-config-restore',
  'modelbridge:app-config-apply',
  'modelbridge:update-check',
  'modelbridge:update-install',
  'modelbridge:open-release',
  'modelbridge:data-choose',
  'modelbridge:data-move',
  'modelbridge:data-open',
] as const
type Channel = (typeof channels)[number]
const operations = new Map<Channel, (value: unknown) => unknown>()
let runtimeReady: Promise<void> = new Promise(() => undefined)
const playgroundRequestSchema = z
  .object({
    id: z.string().uuid(),
    path: z.enum([
      '/health',
      '/v1/models',
      '/v1/responses',
      '/v1/chat/completions',
      '/v1/messages',
    ]),
    body: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

function registerIpc(): void {
  for (const channel of channels)
    ipcMain.handle(
      channel,
      async (event, value: unknown): Promise<Result<unknown>> => {
        if (
          !window
          || event.sender !== window.webContents
          || event.senderFrame !== window.webContents.mainFrame
        )
          return {
            ok: false,
            error: 'Only the ModelBridge main window may perform this action.',
          }
        try {
          await runtimeReady
          const operation = operations.get(channel)
          if (!operation)
            throw new Error('This ModelBridge action is unavailable.')
          return { ok: true, value: await operation(value) }
        } catch (error) {
          const message =
            error instanceof Error ?
              error.message
            : 'ModelBridge operation failed.'
          console.error(`[ModelBridge] ${channel} failed.`)
          log(`${channel} failed`, describeError(error))
          return { ok: false, error: message }
        }
      },
    )
}

async function closeServer(
  server: ReturnType<typeof serve> | null,
): Promise<void> {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error?: Error) => (error ? reject(error) : resolve())),
    )
}

async function listen(gateway: ReturnType<typeof createGateway>, port: number) {
  return new Promise<{ server: ReturnType<typeof serve>; port: number }>(
    (resolve, reject) => {
      const server = serve(
        { fetch: gateway.fetch, hostname: '127.0.0.1', port },
        (address) => resolve({ server, port: address.port }),
      )
      server.once('error', reject)
    },
  )
}

async function initialize(): Promise<void> {
  const state = AppState.open(app.getPath('userData'))
  log('profile loaded')
  if (state.archivedLegacyProfile)
    log(
      'archived encrypted profile from an earlier build; sign in again',
      state.archivedLegacyProfile,
    )
  const sources = new SourceService(state.value.sources, state.vault, (next) =>
    state.save({ ...state.value, sources: next }),
  )
  const usage = await UsageLedger.open(
    path.join(app.getPath('userData'), 'usage'),
  )
  usageLedger = usage
  log('usage history loaded')
  void sources
    .mergeCopilotAccounts()
    .then(async (merged) => {
      if (merged) log('merged duplicate Copilot sources', `${merged} removed`)
      // Sources saved before dev.7 lack premium multipliers.
      for (const source of sources.list())
        if (
          source.kind === 'copilot'
          && source.models.every(
            (model) => model.premiumMultiplier === undefined,
          )
        )
          await sources.refresh(source.id).catch((error: unknown) => {
            log('Copilot catalog refresh failed', describeError(error))
          })
    })
    .catch((error: unknown) => {
      log('Copilot account check failed', describeError(error))
    })
  const requestedPort = Number(process.env.MODELBRIDGE_PORT ?? 4321)
  if (
    !Number.isInteger(requestedPort)
    || requestedPort < 0
    || requestedPort > 65535
  )
    throw new Error('MODELBRIDGE_PORT must be a valid local port.')
  const defaultClientName =
    os.hostname().trim().slice(0, 64) || 'ModelBridge client'
  const clientName = () => state.value.clientName ?? defaultClientName
  const local = await listen(
    createGateway(sources, state.vault.get('local-access'), false, usage, {
      clientName,
    }),
    requestedPort,
  )
  localServer = local.server
  log('local gateway listening', `port ${local.port}`)
  let remoteUrl: string | null = null
  let copilotLogin: CopilotLogin | null = null
  let copilotError: string | null = null
  const helper = {
    command: process.execPath,
    args: [
      ...(app.isPackaged ? [] : [app.getAppPath()]),
      '--modelbridge-credential',
      `--user-data-dir=${app.getPath('userData')}`,
    ],
  }
  const codex = await CodexConfigurations.open(
    codexConfigPath(),
    path.join(app.getPath('userData'), 'codex'),
    state.vault,
    helper,
  )
  const appConfigurations = new AppConfigurations(state.vault)
  let codexVerified = false
  let sharingBusy = false
  const sourceHealth = new Map<string, SourceHealth>()
  const refreshTunnelUser = () =>
    transport.refreshUser().catch((error: unknown) => {
      log('tunnel account check failed', describeError(error))
    })
  void refreshTunnelUser()
  // The user's intent; stays true while an automatic reconnect is pending.
  let sharingWanted = false
  let remotePort = 4322
  const tunnelSettings = () =>
    state.value.tunnelHealth ?? defaultTunnelHealthSettings
  const openSharing = async () => {
    if (!sources.models(true).length)
      throw new Error(
        'Choose at least one model to share before enabling remote access.',
      )
    if (!remoteServer) {
      const remote = await listen(
        createGateway(sources, state.vault.get('remote-access'), true, usage),
        4322,
      )
      remoteServer = remote.server
      remotePort = remote.port
    }
    await transport.prepare()
    const resource = await new DevTunnels(state.value.tunnelId, (args) =>
      transport.command(args),
    ).provision(remotePort)
    const url = await transport.start(resource.id, remotePort)
    if (!transport.running)
      throw new Error(
        transport.error
          ?? 'The tunnel host stopped during startup. Remote access was not enabled.',
      )
    remoteUrl = url
  }
  const closeSharing = async () => {
    await transport.stop()
    await closeServer(remoteServer)
    remoteServer = null
    remoteUrl = null
  }
  const watchdog = new TunnelWatchdog({
    settings: tunnelSettings,
    active: () => sharingWanted && !quitting,
    hostConnections: () =>
      new DevTunnels(state.value.tunnelId, (args) =>
        transport.command(args),
      ).hostConnections(),
    reconnect: async () => {
      if (sharingBusy)
        throw new Error('Remote sharing is starting or stopping.')
      sharingBusy = true
      try {
        await transport.stop()
        await openSharing()
      } catch (error) {
        await closeSharing().catch(() => undefined)
        throw error
      } finally {
        sharingBusy = false
      }
    },
    log,
  })
  powerMonitor.on('resume', () => {
    watchdog.notify('resumed from sleep')
  })
  // Only reads local adapters; nothing is sent over the network.
  const networkSignature = () =>
    Object.values(os.networkInterfaces())
      .flat()
      .filter((address) => address && !address.internal)
      .map((address) => `${address?.family}:${address?.address}`)
      .sort()
      .join(',')
  let network = networkSignature()
  setInterval(() => {
    const next = networkSignature()
    if (next === network) return
    network = next
    watchdog.notify('network changed')
  }, 30_000).unref()
  transport.onHostWarning = (line) => {
    log(
      'tunnel host output',
      line.replace(/[A-Za-z0-9+/=_.-]{40,}/gu, '[redacted]'),
    )
    watchdog.notify('tunnel host reported a problem', { delayMs: 30_000 })
  }
  transport.onUnexpectedStop = () => {
    log('tunnel host exited unexpectedly', transport.error ?? undefined)
    if (transport.replaced || !tunnelSettings().autoReconnect) {
      sharingWanted = false
      watchdog.reset()
    } else {
      transport.error = 'The tunnel host stopped. Reconnecting automatically…'
      watchdog.notify('tunnel host exited', {
        delayMs: 5_000,
        confirmed: true,
      })
    }
    const server = remoteServer
    remoteServer = null
    remoteUrl = null
    sharingBusy = true
    void closeServer(server)
      .catch((error: unknown) => {
        console.error(
          '[ModelBridge] Sharing listener cleanup failed.',
          error instanceof Error ? error.name : 'UnknownError',
        )
        transport.error =
          'The sharing listener could not stop. Exit ModelBridge before reconnecting.'
      })
      .finally(() => {
        sharingBusy = false
      })
  }
  let updateState: UpdateState = {
    phase: 'idle',
    current: app.getVersion(),
    latest: null,
    progress: null,
    error: null,
    checkedAt: null,
  }
  const fetcher = (url: string, init?: RequestInit) => net.fetch(url, init)
  const checkForUpdate = async () => {
    if (['checking', 'downloading', 'installing'].includes(updateState.phase))
      return
    updateState = { ...updateState, phase: 'checking', error: null }
    try {
      const latest = await findUpdate(fetcher, app.getVersion())
      updateState = {
        ...updateState,
        phase: latest ? 'available' : 'current',
        latest,
        checkedAt: new Date().toISOString(),
      }
      if (latest) log('update available', latest.version)
    } catch (error) {
      log('update check failed', describeError(error))
      updateState = {
        ...updateState,
        phase: 'error',
        error:
          error instanceof Error ? error.message : 'The update check failed.',
        checkedAt: new Date().toISOString(),
      }
    }
  }
  if (app.isPackaged && process.env.MODELBRIDGE_UPDATE_CHECK !== '0') {
    setTimeout(() => void checkForUpdate(), 10_000).unref()
    setInterval(() => void checkForUpdate(), 6 * 60 * 60_000).unref()
  }
  const dataMovable = app.isPackaged && !override
  const restartWith = (task: () => Promise<void>) => {
    if (afterShutdown)
      throw new Error('ModelBridge is already restarting. Wait a moment.')
    afterShutdown = task
    setTimeout(() => app.quit(), 250)
  }
  const snapshot = (): AppStatus => ({
    version: app.getVersion(),
    update: updateState,
    data: {
      path: app.getPath('userData'),
      defaultPath: defaultDataDir,
      movable: dataMovable,
      movedFrom,
    },
    role: state.value.role ?? null,
    clientName: clientName(),
    defaultClientName,
    localUrl: `http://127.0.0.1:${local.port}/v1`,
    sources: sources.list(),
    sourceHealth: Object.fromEntries(sourceHealth),
    models: sources.models(),
    sharing: transport.running,
    remoteUrl: transport.running ? remoteUrl : null,
    transportError: transport.error,
    login: transport.login,
    tunnelUser: transport.user,
    tunnelUserChecking: transport.checkingUser,
    tunnelSigningIn: transport.signingIn,
    tunnelAccountError: transport.accountError,
    tunnelHealth: {
      ...watchdog.health(),
      pending: sharingWanted && !transport.running,
    },
    copilotLogin,
    copilotError,
  })
  const handle = <T>(
    channel: Channel,
    operation: (value: unknown) => T | Promise<T>,
  ) => {
    operations.set(channel, operation)
  }
  handle('modelbridge:status', snapshot)
  handle('modelbridge:local-key', () => state.vault.get('local-access'))
  handle('modelbridge:remote-key', () => state.vault.get('remote-access'))
  handle('modelbridge:copilot-login', async (input) => {
    if (copilotController) throw new Error('Copilot sign-in is already active.')
    const value = copilotInputSchema.parse(input)
    const controller = new AbortController()
    copilotController = controller
    copilotError = null
    try {
      const auth = await sources.copilot.beginLogin(controller.signal)
      copilotLogin = auth.login
      void auth
        .complete()
        .then(async (token) => {
          controller.signal.throwIfAborted()
          await sources.addCopilot(
            token,
            value.label,
            value.shared,
            controller.signal,
          )
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return
          console.error('[ModelBridge] Copilot sign-in failed.')
          copilotError =
            error instanceof Error ? error.message : 'Copilot sign-in failed.'
        })
        .finally(() => {
          copilotLogin = null
          copilotController = null
        })
      return snapshot()
    } catch (error) {
      copilotController = null
      throw error
    }
  })
  handle('modelbridge:copilot-cancel', () => {
    copilotController?.abort(new Error('Copilot sign-in was cancelled.'))
    copilotLogin = null
    return snapshot()
  })
  handle('modelbridge:open-login', async (input) => {
    const url = z.string().url().parse(input)
    if (url !== copilotLogin?.url && url !== transport.login?.url)
      throw new Error(
        'Only the current GitHub or Microsoft device sign-in URL may be opened.',
      )
    await shell.openExternal(url)
  })
  handle('modelbridge:refresh-source', async (input) => {
    const id = z.string().uuid().parse(input)
    // A failed check is reported on the source itself rather than as an error.
    try {
      await sources.refresh(id)
      sourceHealth.set(id, {
        ok: true,
        checkedAt: new Date().toISOString(),
        message: null,
      })
    } catch (error) {
      if (!sources.list().some((source) => source.id === id)) throw error
      log('source check failed', describeError(error))
      sourceHealth.set(id, {
        ok: false,
        checkedAt: new Date().toISOString(),
        message:
          error instanceof Error ?
            error.message
          : 'The source did not respond.',
      })
    }
    return snapshot()
  })
  handle('modelbridge:codex-status', () => codex.status(sources.models()))
  handle('modelbridge:codex-discover', async () => {
    const found = await discoverCodex()
    codexVerified = found.installations.length > 0
    return found
  })
  handle('modelbridge:codex-select', async () => {
    if (!window) throw new Error('ModelBridge main window is not available.')
    const selected = await dialog.showOpenDialog(window, {
      title:
        'Select the Codex console executable (resources/codex.exe for desktop)',
      properties: ['openFile'],
      filters: [{ name: 'Codex executable', extensions: ['exe'] }],
    })
    if (selected.canceled || !selected.filePaths[0])
      throw new Error(
        'Codex executable selection was cancelled. No settings were changed.',
      )
    const installation = await inspectCodex(selected.filePaths[0])
    codexVerified = true
    return installation
  })
  handle('modelbridge:codex-preview', (input) => {
    if (!codexVerified)
      throw new Error(
        'Discover or select a supported Codex installation first.',
      )
    const value = z
      .object({ label: z.string(), modelId: z.string() })
      .strict()
      .parse(input)
    return codex.preview(
      value.label,
      value.modelId,
      sources.models(),
      snapshot().localUrl,
    )
  })
  handle('modelbridge:codex-revision', (input) =>
    codex.previewRevision(
      z.string().uuid().parse(input),
      sources.models(),
      snapshot().localUrl,
    ),
  )
  handle('modelbridge:codex-restore', () => codex.restore())
  handle('modelbridge:codex-apply', async (input) => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const { stdout } = await promisify(execFile)(helper.command, helper.args, {
      env,
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    })
    if (stdout.trim() !== state.vault.get('local-access'))
      throw new Error(
        'The installed app could not retrieve the expected protected Codex key. No harness configuration was changed.',
      )
    return codex.apply(z.string().uuid().parse(input))
  })
  handle('modelbridge:codex-reconcile', () => codex.reconcile())
  handle('modelbridge:add-source', async (input) => {
    const added = await sources.add(sourceInputSchema.parse(input))
    sourceHealth.set(added.id, {
      ok: true,
      checkedAt: new Date().toISOString(),
      message: null,
    })
    return snapshot()
  })
  handle('modelbridge:update-source', async (input) => {
    const updated = await sources.update(sourceUpdateSchema.parse(input))
    sourceHealth.set(updated.id, {
      ok: true,
      checkedAt: new Date().toISOString(),
      message: null,
    })
    return snapshot()
  })
  handle('modelbridge:remove-source', async (input) => {
    const id = z.string().uuid().parse(input)
    await sources.remove(id)
    sourceHealth.delete(id)
    return snapshot()
  })
  handle('modelbridge:share-source', (input) => {
    const value = sharingInputSchema.parse(input)
    sources.setShared(value.sourceId, value.shared, value.sharedModelIds)
    return snapshot()
  })
  handle('modelbridge:web-search-model', (input) => {
    const value = z
      .object({
        sourceId: z.string().min(1),
        modelId: z.string().trim().min(1).max(512).nullable(),
      })
      .strict()
      .parse(input)
    sources.setWebSearchModel(value.sourceId, value.modelId)
    return snapshot()
  })
  handle('modelbridge:tunnel-login', async (input) => {
    const provider = z.enum(['github', 'microsoft']).parse(input)
    await transport.prepare()
    transport.beginLogin(provider)
    return snapshot()
  })
  handle('modelbridge:tunnel-check-login', async () => {
    await transport.refreshUser()
    return snapshot()
  })
  handle('modelbridge:sharing-start', async () => {
    if (sharingBusy || remoteServer)
      throw new Error(
        'Remote sharing is already active or starting. Stop it before retrying.',
      )
    if (!sources.models(true).length)
      throw new Error(
        'Choose at least one model to share before enabling remote access.',
      )
    sharingBusy = true
    watchdog.reset()
    try {
      await openSharing()
      sharingWanted = true
      watchdog.configure()
      return snapshot()
    } catch (error) {
      sharingWanted = false
      await transport.stop()
      await closeServer(remoteServer)
      remoteServer = null
      void refreshTunnelUser()
      throw error
    } finally {
      sharingBusy = false
    }
  })
  handle('modelbridge:sharing-stop', async () => {
    if (sharingBusy)
      throw new Error(
        'Wait for remote sharing startup to finish before stopping it.',
      )
    sharingWanted = false
    watchdog.reset()
    await closeSharing()
    return snapshot()
  })
  handle('modelbridge:tunnel-check', async () => {
    await watchdog.checkNow()
    return snapshot()
  })
  handle('modelbridge:tunnel-settings', (input) => {
    state.save({
      ...state.value,
      tunnelHealth: tunnelHealthSettingsSchema.parse(input),
    })
    watchdog.configure()
    return snapshot()
  })
  handle('modelbridge:set-role', (input) => {
    state.save({ ...state.value, role: roleSchema.parse(input) })
    return snapshot()
  })
  handle('modelbridge:set-client-name', (input) => {
    const name = z.string().trim().max(64).nullable().parse(input)
    const next = { ...state.value }
    if (name) next.clientName = name
    else delete next.clientName
    state.save(next)
    return snapshot()
  })
  const premiumLimits = () => state.value.premiumLimits ?? noPremiumLimits
  handle('modelbridge:usage', (input) => ({
    summary: usage.summary(z.enum(usageRanges).parse(input)),
    error: usage.lastError,
    limits: premiumLimits(),
    clients: premiumLimitStatus(usage.month(), premiumLimits()),
  }))
  handle('modelbridge:premium-limits', (input) => {
    state.save({
      ...state.value,
      premiumLimits: premiumLimitsSchema.parse(input),
    })
    return premiumLimits()
  })
  handle('modelbridge:usage-clear', async () => {
    await usage.clear()
    return usage.summary('today')
  })
  handle('modelbridge:copilot-quota', async (input) => {
    const refresh = z.boolean().parse(input)
    return Promise.all(
      sources
        .list()
        .filter((source) => source.kind === 'copilot')
        .map(async (source): Promise<CopilotQuotaStatus> => {
          try {
            return {
              sourceId: source.id,
              label: source.label,
              quota: await sources.copilot.quota(source.id, refresh),
              error: null,
            }
          } catch (error) {
            log('copilot quota check failed', describeError(error))
            return {
              sourceId: source.id,
              label: source.label,
              quota: null,
              error:
                error instanceof Error ?
                  error.message
                : 'Copilot quota could not be read.',
            }
          }
        }),
    )
  })
  const playgroundRequests = new Map<string, AbortController>()
  handle('modelbridge:playground-send', async (input) => {
    const value = playgroundRequestSchema.parse(input)
    if (playgroundRequests.has(value.id))
      throw new Error('This playground request is already running.')
    const controller = new AbortController()
    playgroundRequests.set(value.id, controller)
    const started = performance.now()
    const elapsed = () => Math.round(performance.now() - started)
    try {
      // Requests take the same local gateway path as real coding tools.
      const response = await fetch(
        `http://127.0.0.1:${local.port}${value.path}`,
        {
          method: value.body === undefined ? 'GET' : 'POST',
          headers: {
            authorization: `Bearer ${state.vault.get('local-access')}`,
            'content-type': 'application/json',
            [appHeader]: 'playground',
          },
          ...(value.body !== undefined && { body: JSON.stringify(value.body) }),
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(300_000),
          ]),
        },
      )
      let firstChunkMs: number | null = null
      let received = 0
      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      while (reader) {
        const { done, value: chunk } = await reader.read()
        if (done) break
        firstChunkMs ??= elapsed()
        received += chunk.byteLength
        if (received > 16 * 1024 * 1024) {
          await reader.cancel()
          throw new Error(
            'The playground reply exceeded 16 MB and was stopped.',
          )
        }
        window?.webContents.send('modelbridge:playground-chunk', {
          id: value.id,
          text: decoder.decode(chunk, { stream: true }),
        })
      }
      const tail = decoder.decode()
      if (tail)
        window?.webContents.send('modelbridge:playground-chunk', {
          id: value.id,
          text: tail,
        })
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        durationMs: elapsed(),
        firstChunkMs,
        cancelled: false,
      }
    } catch (error) {
      if (controller.signal.aborted)
        return {
          status: 0,
          contentType: '',
          durationMs: elapsed(),
          firstChunkMs: null,
          cancelled: true,
        }
      throw error
    } finally {
      playgroundRequests.delete(value.id)
    }
  })
  handle('modelbridge:playground-cancel', (input) => {
    playgroundRequests.get(z.string().uuid().parse(input))?.abort()
  })
  handle('modelbridge:copy-text', (input) => {
    clipboard.writeText(z.string().min(1).max(200_000).parse(input))
  })
  // Keys go straight to the clipboard without passing through the window.
  handle('modelbridge:copy-key', (input) => {
    clipboard.writeText(
      state.vault.get(
        z.boolean().parse(input) ? 'remote-access' : 'local-access',
      ),
    )
  })
  handle('modelbridge:app-config-status', (input) =>
    appConfigurations.status(
      configurableAppSchema.parse(input),
      sources.models(),
    ),
  )
  handle('modelbridge:app-config-preview', (input) => {
    const { app: target, modelId } = z
      .object({ app: configurableAppSchema, modelId: z.string().min(1) })
      .strict()
      .parse(input)
    return appConfigurations.preview(target, {
      modelId,
      models: sources.models(),
      origin: `http://127.0.0.1:${local.port}`,
      key: state.vault.get('local-access'),
    })
  })
  handle('modelbridge:app-config-restore', (input) =>
    appConfigurations.restore(configurableAppSchema.parse(input)),
  )
  handle('modelbridge:app-config-apply', (input) =>
    appConfigurations.apply(z.string().uuid().parse(input)),
  )
  handle('modelbridge:update-check', async () => {
    await checkForUpdate()
    return snapshot()
  })
  handle('modelbridge:update-install', async () => {
    const latest = updateState.latest
    if (!latest || updateState.phase !== 'available')
      throw new Error('No update is ready to install. Check for updates first.')
    if (!app.isPackaged)
      throw new Error('Updates install only into the installed app.')
    updateState = { ...updateState, phase: 'downloading', progress: 0 }
    let installer: string
    try {
      installer = await downloadUpdate(
        fetcher,
        latest,
        path.join(app.getPath('temp'), 'ModelBridge-update'),
        (progress) => {
          updateState = { ...updateState, progress }
        },
      )
    } catch (error) {
      updateState = {
        ...updateState,
        phase: 'available',
        progress: null,
        error: error instanceof Error ? error.message : 'The download failed.',
      }
      throw error
    }
    log('update downloaded', latest.version)
    updateState = { ...updateState, phase: 'installing', progress: 1 }
    // The installer reuses the recorded install and data folders when silent,
    // and --force-run reopens ModelBridge when it finishes.
    restartWith(() => {
      try {
        spawn(installer, ['/S', '--updated', '--force-run'], {
          detached: true,
          stdio: 'ignore',
        }).unref()
      } catch (error) {
        dialog.showErrorBox(
          'ModelBridge update failed',
          `${error instanceof Error ? error.message : 'The installer did not start.'}\n\nModelBridge will reopen on version ${app.getVersion()}.`,
        )
        app.relaunch()
      }
      return Promise.resolve()
    })
    return snapshot()
  })
  handle('modelbridge:open-release', async () => {
    const page = updateState.latest?.pageUrl
    if (
      !page?.startsWith(
        'https://github.com/rajathnaik/Copilot-API/releases/tag/',
      )
    )
      throw new Error('No release page is available.')
    await shell.openExternal(page)
  })
  const movableTarget = (input: unknown) => {
    if (!dataMovable)
      throw new Error(
        'The data folder can be moved only in the installed app started normally.',
      )
    return validateDataTarget(
      z.string().min(1).max(1024).parse(input),
      app.getPath('userData'),
      installDir,
    )
  }
  handle('modelbridge:data-choose', async () => {
    if (!window) throw new Error('ModelBridge main window is not available.')
    const selected = await dialog.showOpenDialog(window, {
      title: 'Choose an empty folder for ModelBridge data',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    })
    if (selected.canceled || !selected.filePaths[0]) return null
    return movableTarget(selected.filePaths[0])
  })
  handle('modelbridge:data-move', (input) => {
    const target = movableTarget(input)
    // Fail now, not after shutdown, when the install folder is read-only.
    const probe = path.join(installDir, `${pointerFile}.probe`)
    fs.writeFileSync(probe, '')
    fs.rmSync(probe)
    const from = app.getPath('userData')
    const created = !fs.existsSync(target)
    restartWith(async () => {
      try {
        const skipped = copyProfile(from, target)
        if (skipped.length)
          log('data move skipped cache entries', skipped.join(', '))
        await writeDataRegistry(target)
        try {
          writeDataLocation(installDir, target)
        } catch (error) {
          await writeDataRegistry(from).catch(() => undefined)
          throw error
        }
        log('data folder moved', target)
        app.relaunch({
          args: [
            ...process.argv
              .slice(1)
              .filter((arg) => !arg.startsWith('--modelbridge-moved-from=')),
            `--modelbridge-moved-from=${from}`,
          ],
        })
      } catch (error) {
        log('data move failed', describeError(error))
        if (created)
          fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 })
        else
          for (const entry of fs.readdirSync(target))
            fs.rmSync(path.join(target, entry), {
              recursive: true,
              force: true,
              maxRetries: 3,
            })
        dialog.showErrorBox(
          'ModelBridge could not move its data',
          `${error instanceof Error ? error.message : 'The copy failed.'}\n\nYour data is still in ${from}, and ModelBridge will reopen using it.`,
        )
        app.relaunch()
      }
    })
    return snapshot()
  })
  handle('modelbridge:data-open', async () => {
    const failed = await shell.openPath(app.getPath('userData'))
    if (failed) throw new Error(failed)
  })
  const missing = channels.filter((channel) => !operations.has(channel))
  if (missing.length)
    throw new Error(`ModelBridge actions are missing: ${missing.join(', ')}`)
}

function showWindow(): void {
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

/** Creates the window before the runtime starts so slow OS services never leave the app invisible. */
function createWindow(): void {
  window = new BrowserWindow({
    title: 'ModelBridge',
    width: 1120,
    height: 820,
    minWidth: 760,
    minHeight: 600,
    backgroundColor: '#edf2f8',
    icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      window?.hide()
    }
  })
  window.on('unresponsive', () => log('window unresponsive'))
  window.on('responsive', () => log('window responsive again'))
  window.webContents.on('render-process-gone', (_event, details) =>
    log('renderer process gone', details.reason),
  )
  window.webContents.on('did-fail-load', (_event, code, description) =>
    log('renderer load failed', `${code} ${description}`),
  )
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  tray = new Tray(
    nativeImage.createFromPath(
      path.join(app.getAppPath(), 'assets', 'tray.png'),
    ),
  )
  tray.setToolTip('ModelBridge')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open ModelBridge', click: showWindow },
      { label: 'Exit ModelBridge', click: () => app.quit() },
    ]),
  )
  tray.on('double-click', showWindow)
  const loading =
    !app.isPackaged && process.env.ELECTRON_RENDERER_URL ?
      window.loadURL(process.env.ELECTRON_RENDERER_URL)
    : window.loadFile(path.join(__dirname, '../renderer/index.html'))
  void loading.then(
    () => log('renderer loaded'),
    (error: unknown) => log('renderer load failed', describeError(error)),
  )
  log('window created')
}

app.on('before-quit', (event) => {
  if (credentialMode) return
  if (quitting) return
  event.preventDefault()
  quitting = true
  copilotController?.abort(new Error('ModelBridge is shutting down.'))
  void transport
    .dispose()
    .then(() =>
      Promise.all([closeServer(localServer), closeServer(remoteServer)]),
    )
    .then(() => usageLedger?.flush())
    .then(() => afterShutdown?.())
    .then(() => app.quit())
    .catch((error: unknown) => {
      console.error(
        '[ModelBridge] Runtime shutdown failed.',
        error instanceof Error ? error.name : 'UnknownError',
      )
      app.exit(1)
    })
})
if (credentialMode) {
  // The helper only reads a file; skipping Chromium readiness and GPU startup
  // keeps Codex key lookups fast and avoids intermittent native exit codes.
  app.disableHardwareAcceleration()
  void Promise.resolve()
    .then(() => {
      if (!fs.existsSync(path.join(app.getPath('userData'), 'state.json')))
        throw new Error(
          'This ModelBridge profile has no saved gateway state. Open the app and reconnect; the helper will not generate replacement keys.',
        )
      stateSchema.parse(
        JSON.parse(
          fs.readFileSync(
            path.join(app.getPath('userData'), 'state.json'),
            'utf8',
          ),
        ),
      )
      const store = CredentialStore.open(
        path.join(app.getPath('userData'), credentialsFile),
      )
      process.stdout.write(store.get('local-access'), () => app.exit(0))
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `ModelBridge credential helper failed: ${error instanceof Error ? error.message : 'Unknown failure'}\n`,
        () => app.exit(1),
      )
    })
} else if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    log('second launch focused the running window')
    showWindow()
  })
  app.on('child-process-gone', (_event, details) =>
    log('child process gone', `${details.type} ${details.reason}`),
  )
  void app
    .whenReady()
    .then(async () => {
      log('app ready', `version ${app.getVersion()}`)
      registerIpc()
      createWindow()
      runtimeReady = initialize()
      await runtimeReady
      log('runtime ready')
    })
    .catch(async (error: unknown) => {
      await diagnostics.write('startup failed', describeError(error))
      dialog.showErrorBox(
        'ModelBridge startup failed',
        `${error instanceof Error ? error.message : 'Unknown startup error.'}\n\nDiagnostics: ${diagnostics.file}`,
      )
      app.exit(1)
    })
}
