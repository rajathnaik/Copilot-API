import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
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
  stateSchema,
} from '@modelbridge/runtime/contracts'
import type { CopilotLogin } from '@modelbridge/runtime/copilot'
import { CodexConfigurations } from '@modelbridge/runtime/codex'
import { DevTunnels } from '@modelbridge/runtime/dev-tunnels'
import {
  EncryptedVault,
  type CredentialCodec,
} from '@modelbridge/runtime/credentials'
import type { AppStatus, Result } from '../src/types'
import { AppState } from './state'
import { TunnelProcess } from './devtunnel-process'
import { codexConfigPath, discoverCodex, inspectCodex } from './codex-discovery'
import { windowsCredentialCodec } from './windows-credentials'

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
const transport = new TunnelProcess()
let copilotController: AbortController | null = null
const credentialMode = process.argv.includes('--modelbridge-credential')

function credentialCodec(): CredentialCodec {
  const legacy: CredentialCodec = {
    encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
  }
  return process.platform === 'win32' ?
      windowsCredentialCodec(app.getPath('userData'), legacy)
    : legacy
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
  if (
    !safeStorage.isEncryptionAvailable()
    || (process.platform === 'linux'
      && safeStorage.getSelectedStorageBackend() === 'basic_text')
  )
    throw new Error(
      'OS-protected credential storage is required. Plaintext storage is not supported.',
    )
  const state = new AppState(app.getPath('userData'), credentialCodec())
  if (process.platform === 'win32')
    state.vault.set('local-access', state.vault.get('local-access'))
  const sources = new SourceService(state.value.sources, state.vault, (next) =>
    state.save({ ...state.value, sources: next }),
  )
  const requestedPort = Number(process.env.MODELBRIDGE_PORT ?? 4321)
  if (
    !Number.isInteger(requestedPort)
    || requestedPort < 0
    || requestedPort > 65535
  )
    throw new Error('MODELBRIDGE_PORT must be a valid local port.')
  const local = await listen(
    createGateway(sources, state.vault.get('local-access')),
    requestedPort,
  )
  localServer = local.server
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
  const codex = new CodexConfigurations(
    codexConfigPath(),
    path.join(app.getPath('userData'), 'codex'),
    state.vault,
    helper,
  )
  let codexVerified = false
  let sharingBusy = false
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
    localUrl: `http://127.0.0.1:${local.port}/v1`,
    sources: sources.list(),
    models: sources.models(),
    sharing: transport.running,
    remoteUrl: transport.running ? remoteUrl : null,
    transportError: transport.error,
    login: transport.login,
    copilotLogin,
    copilotError,
  })
  const handle = <T>(
    channel: string,
    operation: (value: unknown) => T | Promise<T>,
  ) => {
    ipcMain.handle(
      channel,
      async (event, value: unknown): Promise<Result<T>> => {
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
          return { ok: true, value: await operation(value) }
        } catch (error) {
          const message =
            error instanceof Error ?
              error.message
            : 'ModelBridge operation failed.'
          console.error(`[ModelBridge] ${channel} failed.`)
          return { ok: false, error: message }
        }
      },
    )
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
    sources.setShared(value.sourceId, value.shared)
    return snapshot()
  })
  handle('modelbridge:tunnel-login', () => {
    transport.beginLogin()
    return snapshot()
  })
  handle('modelbridge:sharing-start', async () => {
    if (sharingBusy || remoteServer)
      throw new Error(
        'Remote sharing is already active or starting. Stop it before retrying.',
      )
    if (!sources.models(true).length)
      throw new Error(
        'Choose at least one source to share before enabling remote access.',
      )
    sharingBusy = true
    try {
      const remote = await listen(
        createGateway(sources, state.vault.get('remote-access'), true),
        4322,
      )
      remoteServer = remote.server
      const resource = await new DevTunnels(state.value.tunnelId, (args) =>
        transport.command(args),
      ).provision(remote.port)
      await transport.start(resource.id)
      if (!transport.running)
        throw new Error(
          transport.error
            ?? 'The tunnel host stopped during startup. Remote access was not enabled.',
        )
      remoteUrl = resource.url
      return snapshot()
    } catch (error) {
      await transport.stop()
      await closeServer(remoteServer)
      remoteServer = null
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
  window = new BrowserWindow({
    title: 'ModelBridge',
    width: 1120,
    height: 820,
    minWidth: 760,
    minHeight: 600,
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
      { label: 'Open ModelBridge', click: () => window?.show() },
      { label: 'Exit ModelBridge', click: () => app.quit() },
    ]),
  )
  tray.on('double-click', () => window?.show())
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL)
    await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await window.loadFile(path.join(__dirname, '../renderer/index.html'))
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
      if (!safeStorage.isEncryptionAvailable())
        throw new Error('OS-protected key storage is unavailable.')
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
      const vault = new EncryptedVault(
        path.join(app.getPath('userData'), 'credentials.encrypted.json'),
        credentialCodec(),
      )
      process.stdout.write(vault.get('local-access'), () => app.exit(0))
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
    window?.show()
    window?.focus()
  })
  void app
    .whenReady()
    .then(initialize)
    .catch((error: unknown) => {
      dialog.showErrorBox(
        'ModelBridge startup failed',
        error instanceof Error ? error.message : 'Unknown startup error.',
      )
      app.exit(1)
    })
}
