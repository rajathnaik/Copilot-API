import { app, BrowserWindow, dialog, ipcMain, net, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomically } from '../../src/lib/atomic-file'
import type {
  ConnectorInput,
  ConnectorResult,
  ConnectorStatus,
} from '../src/types/connector'
import { codexConfigPath, detectCodex } from './connector/codex'
import { ConnectorService } from './connector/service'
import { ConnectorStore, type CredentialCodec } from './connector/store'

const PRODUCT_NAME = 'Copilot API Connector'
app.setName(PRODUCT_NAME)
const userDataOverride = app.commandLine.getSwitchValue('user-data-dir')
app.setPath(
  'userData',
  userDataOverride ?
    path.resolve(userDataOverride)
  : path.join(app.getPath('appData'), PRODUCT_NAME),
)
app.setAppUserModelId('com.copilot-api.connector')

const tokenMode = process.argv.includes('--connector-token')
if (tokenMode) app.commandLine.appendSwitch('disable-gpu')

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
const executableFile = path.join(store.directory, 'codex-executable.txt')

function selectedExecutable(): string | null {
  try {
    const value = fs.readFileSync(executableFile, 'utf8').trim()
    if (!path.isAbsolute(value))
      throw new Error('The saved Codex executable path must be absolute.')
    return value
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return null
    throw error
  }
}

const installation = () => detectCodex(selectedExecutable())
const service = new ConnectorService(store, {
  installation,
  fetcher: (url, init) => net.fetch(url, init),
  helperCommand:
    process.platform === 'linux' && process.env.APPIMAGE ?
      process.env.APPIMAGE
    : process.execPath,
  helperArgs:
    app.isPackaged ?
      ['--connector-token', `--user-data-dir=${store.directory}`]
    : [
        path.join(__dirname, 'index.js'),
        '--connector-token',
        `--user-data-dir=${store.directory}`,
      ],
})

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
  )
    throw new Error('Invalid connector input.')
  return {
    url: value.url,
    apiKey: value.apiKey,
    model:
      'model' in value && typeof value.model === 'string' && value.model ?
        value.model
      : undefined,
  }
}

async function status(): Promise<ConnectorStatus> {
  return {
    installation: await installation(),
    connection: store.state()?.connection ?? null,
    secureStorage: codec.available(),
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
  handle('connector:status', status)
  handle('connector:discover', (input) => service.discover(parseInput(input)))
  handle('connector:connect', (input) => service.connect(parseInput(input)))
  handle('connector:refresh', () => service.refresh())
  handle('connector:undo', async () => {
    await service.undo()
    return null
  })
  handle('connector:select-codex', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Select Codex executable',
      properties: ['openFile'],
      ...(process.platform === 'win32' ?
        {
          filters: [{ name: 'Codex executable', extensions: ['exe'] }],
        }
      : {}),
    })
    if (!result.canceled && result.filePaths[0]) {
      await detectCodex(result.filePaths[0])
      writeFileAtomically(executableFile, result.filePaths[0])
    }
    return status()
  })
}

if (!tokenMode && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void app
    .whenReady()
    .then(async () => {
      if (tokenMode) {
        process.stdout.write(`${store.key()}\n`, () => app.exit(0))
        return
      }
      await store.exclusive(() => Promise.resolve())
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
          : path.join(app.getAppPath(), 'assets', 'icon.png'),
        webPreferences: {
          preload: path.join(__dirname, '../preload/index.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })
      registerHandlers(window)
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      window.webContents.on('will-navigate', (event) => event.preventDefault())
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
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : 'Connector startup failed.'
      if (tokenMode) {
        process.stderr.write(`Credential helper failed: ${message}\n`)
      } else {
        console.error(`[connector] ${message}`)
        dialog.showErrorBox(PRODUCT_NAME, message)
      }
      app.exit(1)
    })
}
