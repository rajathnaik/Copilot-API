import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Tray,
  shell,
} from 'electron'
import path from 'node:path'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'
import { z } from 'zod'
import { createGateway, serve, SourceService } from '@modelbridge/runtime'
import {
  sharingInputSchema,
  sourceInputSchema,
  copilotInputSchema,
  roleSchema,
  stateSchema,
} from '@modelbridge/runtime/contracts'
import type { CopilotLogin } from '@modelbridge/runtime/copilot'
import { CodexConfigurations } from '@modelbridge/runtime/codex'
import { DevTunnels } from '@modelbridge/runtime/dev-tunnels'
import { CredentialStore } from '@modelbridge/runtime/credentials'
import { UsageLedger, usageRanges } from '@modelbridge/runtime/usage'
import type { AppStatus, CopilotQuotaStatus, Result } from '../src/types'
import { AppState, credentialsFile } from './state'
import { TunnelProcess } from './devtunnel-process'
import { codexConfigPath, discoverCodex, inspectCodex } from './codex-discovery'
import { createDiagnosticsLog, describeError } from './diagnostics'

app.setName('ModelBridge')
app.setAppUserModelId('com.rajathnaik.modelbridge')
const override = app.commandLine.getSwitchValue('user-data-dir')
app.setPath(
  'userData',
  override ?
    path.resolve(override)
  : path.join(app.getPath('appData'), 'ModelBridge'),
)
app.setPath('sessionData', app.getPath('userData'))

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
  'modelbridge:share-source',
  'modelbridge:web-search-model',
  'modelbridge:tunnel-login',
  'modelbridge:tunnel-check-login',
  'modelbridge:sharing-start',
  'modelbridge:sharing-stop',
  'modelbridge:set-role',
  'modelbridge:usage',
  'modelbridge:usage-clear',
  'modelbridge:copilot-quota',
] as const
type Channel = (typeof channels)[number]
const operations = new Map<Channel, (value: unknown) => unknown>()
let runtimeReady: Promise<void> = new Promise(() => undefined)

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
  const requestedPort = Number(process.env.MODELBRIDGE_PORT ?? 4321)
  if (
    !Number.isInteger(requestedPort)
    || requestedPort < 0
    || requestedPort > 65535
  )
    throw new Error('MODELBRIDGE_PORT must be a valid local port.')
  const local = await listen(
    createGateway(sources, state.vault.get('local-access'), false, usage),
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
  let codexVerified = false
  let sharingBusy = false
  const refreshTunnelUser = () =>
    transport.refreshUser().catch((error: unknown) => {
      log('tunnel account check failed', describeError(error))
    })
  void refreshTunnelUser()
  transport.onUnexpectedStop = () => {
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
  const snapshot = (): AppStatus => ({
    version: app.getVersion(),
    role: state.value.role ?? null,
    localUrl: `http://127.0.0.1:${local.port}/v1`,
    sources: sources.list(),
    models: sources.models(),
    sharing: transport.running,
    remoteUrl: transport.running ? remoteUrl : null,
    transportError: transport.error,
    login: transport.login,
    tunnelUser: transport.user,
    tunnelUserChecking: transport.checkingUser,
    tunnelSigningIn: transport.signingIn,
    tunnelAccountError: transport.accountError,
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
    await sources.refresh(z.string().uuid().parse(input))
    return snapshot()
  })
  handle('modelbridge:codex-status', () => codex.status())
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
    await sources.add(sourceInputSchema.parse(input))
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
    try {
      const remote = await listen(
        createGateway(sources, state.vault.get('remote-access'), true, usage),
        4322,
      )
      remoteServer = remote.server
      await transport.prepare()
      const resource = await new DevTunnels(state.value.tunnelId, (args) =>
        transport.command(args),
      ).provision(remote.port)
      const url = await transport.start(resource.id, remote.port)
      if (!transport.running)
        throw new Error(
          transport.error
            ?? 'The tunnel host stopped during startup. Remote access was not enabled.',
        )
      remoteUrl = url
      return snapshot()
    } catch (error) {
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
    await transport.stop()
    await closeServer(remoteServer)
    remoteServer = null
    remoteUrl = null
    return snapshot()
  })
  handle('modelbridge:set-role', (input) => {
    state.save({ ...state.value, role: roleSchema.parse(input) })
    return snapshot()
  })
  handle('modelbridge:usage', (input) => ({
    summary: usage.summary(z.enum(usageRanges).parse(input)),
    error: usage.lastError,
  }))
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
  void app
    .whenReady()
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
