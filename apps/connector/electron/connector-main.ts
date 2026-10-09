import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  safeStorage,
  shell,
} from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { writeFileAtomically } from '@copilot-api/shared/atomic-file'
import type {
  ConnectorInput,
  ConnectorResult,
  ConnectorStatus,
  ConnectorHarness,
  ConnectorProfile,
} from '../src/types/connector'
import { CONNECTOR_HARNESSES, isConnectorHarness } from '../src/types/connector'
import { codexConfigPath, detectCodex } from './connector/codex'
import { ConnectorService } from './connector/service'
import { ConnectorStore, type CredentialCodec } from './connector/store'
import {
  detectHarness,
  harnessConfigPath,
  HARNESS_GUIDES,
  profileDirectory,
} from './connector/harness'
import { HarnessService, resolveSharedInput } from './connector/harness-service'

const PRODUCT_NAME = 'Copilot API Connector'
app.setName(PRODUCT_NAME)
const userDataOverride = app.commandLine.getSwitchValue('user-data-dir')
app.setPath(
  'userData',
  userDataOverride ?
    path.resolve(userDataOverride)
  : path.join(app.getPath('appData'), PRODUCT_NAME),
)
app.setPath('sessionData', app.getPath('userData'))
app.setAppUserModelId('com.copilot-api.connector')

const tokenMode = process.argv.includes('--connector-token')
const storageInitMode = process.argv.includes('--connector-storage-init')
const openClawTokenMode = process.argv.includes('--connector-openclaw-secret')
const helperMode = tokenMode || storageInitMode || openClawTokenMode
if (helperMode) app.commandLine.appendSwitch('disable-gpu')

const codec: CredentialCodec = {
  available: () =>
    safeStorage.isEncryptionAvailable()
    && (process.platform !== 'linux'
      || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(
        safeStorage.getSelectedStorageBackend(),
      )),
  encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
  decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
}
const store = new ConnectorStore(
  app.getPath('userData'),
  codexConfigPath(),
  codec,
)
const stores: Partial<Record<ConnectorHarness, ConnectorStore>> = {
  codex: store,
}
function harnessStore(harness: ConnectorHarness): ConnectorStore {
  const existing = stores[harness]
  if (existing) return existing
  const next = new ConnectorStore(
    profileDirectory(store.directory, harness),
    harnessConfigPath(harness),
    codec,
    harness,
  )
  stores[harness] = next
  return next
}
function executableFile(harness: ConnectorHarness): string {
  return path.join(harnessStore(harness).directory, `${harness}-executable.txt`)
}
const helperCommand =
  process.platform === 'linux' && process.env.APPIMAGE ?
    process.env.APPIMAGE
  : process.execPath
function helperArgs(
  mode: string,
  harness: ConnectorHarness = 'codex',
): string[] {
  return [
    ...(app.isPackaged ? [] : [path.join(__dirname, 'index.js')]),
    mode,
    `--user-data-dir=${store.directory}`,
    ...(harness === 'codex' ? [] : [`--connector-harness=${harness}`]),
  ]
}

function initializeWindowsStorage(): void {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  // Persist Chromium's encryption key before the GUI reads Local State.
  const output = execFileSync(
    helperCommand,
    helperArgs('--connector-storage-init'),
    { env, encoding: 'utf8', timeout: 30_000, windowsHide: true },
  )
  if (output.trim() !== 'CONNECTOR_STORAGE_READY')
    throw new Error(
      'The credential storage initializer returned an invalid result.',
    )
}

function selectedExecutable(
  harness: ConnectorHarness = 'codex',
): string | null {
  try {
    const value = fs.readFileSync(executableFile(harness), 'utf8').trim()
    if (!path.isAbsolute(value))
      throw new Error('The saved harness executable path must be absolute.')
    return value
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null
    throw error
  }
}

const installation = (harness: ConnectorHarness = 'codex') =>
  harness === 'codex' ?
    detectCodex(selectedExecutable(harness))
  : detectHarness(harness, selectedExecutable(harness))
const codexService = new ConnectorService(store, {
  installation: () => installation(),
  fetcher: (url, init) => net.fetch(url, init),
  helperCommand,
  helperArgs: helperArgs('--connector-token'),
})

function selectedHarness(value: unknown): ConnectorHarness {
  if (value === undefined) return 'codex'
  if (!isConnectorHarness(value)) throw new Error('Invalid connector harness.')
  return value
}

function service(harness: ConnectorHarness): ConnectorService | HarnessService {
  return harness === 'codex' ? codexService : (
      new HarnessService(harness, harnessStore(harness), {
        installation: () => installation(harness),
        fetcher: (url, init) => net.fetch(url, init),
        helperCommand:
          harness === 'openclaw' ?
            fs.realpathSync(helperCommand)
          : helperCommand,
        helperArgs: helperArgs(
          harness === 'openclaw' ?
            '--connector-openclaw-secret'
          : '--connector-token',
          harness,
        ),
      })
    )
}

function parseInput(value: unknown): ConnectorInput {
  if (
    value === null
    || typeof value !== 'object'
    || !('url' in value)
    || typeof value.url !== 'string'
    || !('apiKey' in value)
    || typeof value.apiKey !== 'string'
    || ('model' in value
      && value.model !== undefined
      && typeof value.model !== 'string')
    || ('harness' in value
      && value.harness !== undefined
      && !isConnectorHarness(value.harness))
    || ('copyFrom' in value
      && value.copyFrom !== undefined
      && !isConnectorHarness(value.copyFrom))
    || ('allowPlaintext' in value
      && value.allowPlaintext !== undefined
      && typeof value.allowPlaintext !== 'boolean')
  )
    throw new Error('Invalid connector input.')
  return {
    harness: selectedHarness('harness' in value ? value.harness : undefined),
    url: value.url,
    apiKey: value.apiKey,
    model:
      'model' in value && typeof value.model === 'string' && value.model ?
        value.model
      : undefined,
    copyFrom:
      'copyFrom' in value && isConnectorHarness(value.copyFrom) ?
        value.copyFrom
      : undefined,
    allowPlaintext: 'allowPlaintext' in value && value.allowPlaintext === true,
  }
}

async function resolveInput(value: unknown): Promise<ConnectorInput> {
  return resolveSharedInput(parseInput(value), harnessStore)
}

async function status(
  harness: ConnectorHarness = 'codex',
): Promise<ConnectorStatus> {
  const profiles: ConnectorProfile[] = CONNECTOR_HARNESSES.map((id) => {
    try {
      return {
        harness: id,
        connection: harnessStore(id).state()?.connection ?? null,
      }
    } catch {
      const error = `The saved ${id} profile cannot be read. Restore its configuration home or saved state before using it.`
      console.error(`[connector] ${error}`)
      return { harness: id, connection: null, error }
    }
  })
  return {
    appVersion: app.getVersion(),
    installation: await installation(harness),
    connection: harnessStore(harness).state()?.connection ?? null,
    secureStorage: codec.available(),
    profiles,
  }
}

function registerHandlers(window: BrowserWindow): void {
  function handle<T>(
    channel: string,
    operation: (input: unknown) => Promise<T>,
  ): void {
    ipcMain.handle(
      channel,
      async (event, input: unknown): Promise<ConnectorResult<T>> => {
        if (
          event.sender !== window.webContents
          || event.senderFrame !== window.webContents.mainFrame
        ) {
          return {
            ok: false,
            error: 'Connector requests are allowed only from its main window.',
          }
        }
        try {
          return { ok: true, value: await operation(input) }
        } catch (error) {
          let message =
            error instanceof Error ?
              error.message
            : 'The connector operation failed.'
          if (
            input !== null
            && typeof input === 'object'
            && 'apiKey' in input
            && typeof input.apiKey === 'string'
            && input.apiKey.trim()
          ) {
            message = message.split(input.apiKey.trim()).join('[redacted]')
          }
          console.error(`[connector] ${channel}: ${message}`)
          return { ok: false, error: message }
        }
      },
    )
  }
  handle('connector:status', (input) => status(selectedHarness(input)))
  handle('connector:reveal-key', (input) =>
    harnessStore(selectedHarness(input)).revealKey(),
  )
  handle('connector:discover', async (value) => {
    const input = await resolveInput(value)
    return service(input.harness ?? 'codex').discover(input)
  })
  handle('connector:connect', async (value) => {
    const input = await resolveInput(value)
    return service(input.harness ?? 'codex').connect(input)
  })
  handle('connector:repair', async (value) => {
    const input = await resolveInput(value)
    return service(input.harness ?? 'codex').connect(input, true)
  })
  handle('connector:refresh', (input) =>
    service(selectedHarness(input)).refresh(),
  )
  handle('connector:undo', async (input) => {
    await service(selectedHarness(input)).undo()
    return null
  })
  handle('connector:select-executable', async (input) => {
    const harness = selectedHarness(input)
    const result = await dialog.showOpenDialog(window, {
      title: 'Select harness executable',
      properties: ['openFile'],
      ...(process.platform === 'win32' ?
        {
          filters: [{ name: 'Harness executable', extensions: ['exe'] }],
        }
      : {}),
    })
    if (!result.canceled && result.filePaths[0]) {
      if (harness === 'codex') await detectCodex(result.filePaths[0])
      else await detectHarness(harness, result.filePaths[0])
      writeFileAtomically(executableFile(harness), result.filePaths[0])
    }
    return status(harness)
  })
  handle('connector:reset-executable', async (input) => {
    const harness = selectedHarness(input)
    await harnessStore(harness).exclusive(() => {
      try {
        fs.unlinkSync(executableFile(harness))
      } catch (error) {
        if (
          !(
            error instanceof Error
            && 'code' in error
            && error.code === 'ENOENT'
          )
        )
          throw error
      }
      return Promise.resolve()
    })
    return status(harness)
  })
  handle('connector:open-install-guide', async (input) => {
    await shell.openExternal(HARNESS_GUIDES[selectedHarness(input)])
    return null
  })
}

function startupError(error: unknown): void {
  const message =
    error instanceof Error ? error.message : 'Connector startup failed.'
  if (helperMode) {
    process.stderr.write(`Credential helper failed: ${message}\n`)
  } else {
    console.error(`[connector] ${message}`)
    dialog.showErrorBox(PRODUCT_NAME, message)
  }
  app.exit(1)
}

if (!helperMode && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  try {
    if (!helperMode && process.platform === 'win32') initializeWindowsStorage()
    void app
      .whenReady()
      .then(async () => {
        if (storageInitMode) {
          if (!codec.available())
            throw new Error('OS-protected credential storage is unavailable.')
          safeStorage.encryptString('connector-storage-initialization')
          process.stdout.write('CONNECTOR_STORAGE_READY\n', () => app.quit())
          return
        }
        if (tokenMode) {
          const harness = selectedHarness(
            app.commandLine.getSwitchValue('connector-harness') || undefined,
          )
          process.stdout.write(`${harnessStore(harness).key()}\n`, () =>
            app.quit(),
          )
          return
        }
        if (openClawTokenMode) {
          const harness = selectedHarness(
            app.commandLine.getSwitchValue('connector-harness') || undefined,
          )
          if (harness !== 'openclaw')
            throw new Error('OpenClaw secret mode requires its profile.')
          // OpenClaw supports JSON-string output for a single-ID exec provider.
          // Electron GUI executables cannot reliably read piped stdin on Windows.
          process.stdout.write(
            `${JSON.stringify(harnessStore(harness).key())}\n`,
            () => app.quit(),
          )
          return
        }
        for (const harness of CONNECTOR_HARNESSES)
          await harnessStore(harness).exclusive(() => Promise.resolve())
        const window = new BrowserWindow({
          title: PRODUCT_NAME,
          width: 900,
          height: 840,
          minWidth: 560,
          minHeight: 600,
          backgroundColor: '#fafafa',
          icon:
            app.isPackaged ?
              path.join(process.resourcesPath, 'icon.png')
            : path.join(app.getAppPath(), 'assets', 'connector-icon.png'),
          webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        })
        registerHandlers(window)
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        window.webContents.on('will-navigate', (event) =>
          event.preventDefault(),
        )
        app.on('second-instance', () => {
          if (window.isMinimized()) window.restore()
          window.show()
          window.focus()
        })
        app.on('window-all-closed', () => app.quit())
        if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
          await window.loadURL(
            `${process.env.ELECTRON_RENDERER_URL}/connector.html`,
          )
        } else {
          await window.loadFile(
            path.join(__dirname, '../renderer/connector.html'),
          )
        }
      })
      .catch(startupError)
  } catch (error) {
    startupError(error)
  }
}
