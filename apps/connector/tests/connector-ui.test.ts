import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import connectorBuilder from '../connector-builder.json'
import manifest from '../package.json'
import ConnectorApp from '../src/connector/App'
import { LanguageProvider } from '@copilot-api/shared/language'
import type {
  ConnectorAPI,
  ConnectorConnection,
  ConnectorDiscovery,
  ConnectorStatus,
  ConnectorHarness,
} from '../src/types/connector'

const connection: ConnectorConnection = {
  harness: 'codex',
  baseUrl: 'https://example.devtunnels.ms',
  model: 'gpt-test',
  modelCount: 2,
  catalogMode: 'remote',
  verifiedAt: '2026-10-09T00:00:00Z',
  configPath: 'C:\\Fixture\\Codex\\config.toml',
}
const initial: ConnectorStatus = {
  appVersion: '2.7.1',
  installation: {
    executable: 'codex',
    version: '0.160.0',
    configPath: connection.configPath,
  },
  connection: null,
  secureStorage: true,
}
const discovery: ConnectorDiscovery = {
  baseUrl: connection.baseUrl,
  defaultModel: 'gpt-test',
  models: [
    {
      id: 'gpt-test',
      name: 'GPT Test',
      contextWindow: 128_000,
      description: 'Native Responses',
    },
    {
      id: 'claude-test',
      name: 'Claude Test',
      contextWindow: 200_000,
      description: 'Messages adapter',
    },
  ],
  catalogMode: 'remote',
  excludedModels: ['embedding'],
}
let win: Window
let root: Root
let container: HTMLDivElement
let status: ReturnType<typeof mock<ConnectorAPI['status']>>
let connect: ReturnType<typeof mock<ConnectorAPI['connect']>>
let revealKey: ReturnType<typeof mock<ConnectorAPI['revealKey']>>
let repair: ReturnType<typeof mock<ConnectorAPI['repair']>>
let discover: ReturnType<typeof mock<ConnectorAPI['discover']>>
let refresh: ReturnType<typeof mock<ConnectorAPI['refresh']>>
let undo: ReturnType<typeof mock<ConnectorAPI['undo']>>
let select: ReturnType<typeof mock<ConnectorAPI['selectExecutable']>>
let reset: ReturnType<typeof mock<ConnectorAPI['resetExecutable']>>
let installGuide: ReturnType<typeof mock<ConnectorAPI['openInstallGuide']>>
const previousGlobals = new Map<string, PropertyDescriptor | undefined>()

beforeEach(async () => {
  win = new Window({ url: 'http://localhost' })
  const globals: Record<string, unknown> = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    Event: win.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  for (const [name, value] of Object.entries(globals)) {
    previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    })
  }
  status = mock(() => Promise.resolve({ ok: true, value: { ...initial } }))
  connect = mock(() => Promise.resolve({ ok: true, value: { ...connection } }))
  revealKey = mock(() =>
    Promise.resolve({ ok: true, value: 'synthetic-saved-key' }),
  )
  repair = mock(() => Promise.resolve({ ok: true, value: { ...connection } }))
  discover = mock(() => Promise.resolve({ ok: true, value: { ...discovery } }))
  refresh = mock(() => Promise.resolve({ ok: true, value: { ...connection } }))
  undo = mock(() => Promise.resolve({ ok: true, value: null }))
  select = mock(() => Promise.resolve({ ok: true, value: { ...initial } }))
  reset = mock(() => Promise.resolve({ ok: true, value: { ...initial } }))
  installGuide = mock(() => Promise.resolve({ ok: true, value: null }))
  const api: ConnectorAPI = {
    status,
    connect,
    revealKey,
    repair,
    discover,
    refresh,
    undo,
    selectExecutable: select,
    resetExecutable: reset,
    openInstallGuide: installGuide,
  }
  Object.defineProperty(win, 'connectorAPI', { value: api, configurable: true })
  container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  await win.happyDOM.close()
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
  previousGlobals.clear()
})

async function render(key?: string) {
  await act(async () =>
    root.render(
      createElement(LanguageProvider, {
        children: createElement(ConnectorApp, { key }),
      }),
    ),
  )
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (element) => element.textContent === label,
  )
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}

async function click(label: string) {
  await act(async () => button(label).click())
}

async function fill(id: string, value: string) {
  const element = container.querySelector<HTMLInputElement>(`#${id}`)
  if (!element) throw new Error(`Missing input: ${id}`)
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )
  if (!descriptor?.set) throw new Error('Missing native input setter')
  await act(async () => {
    descriptor.set?.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function choose(id: string, value: string) {
  const element = container.querySelector<HTMLSelectElement>(`#${id}`)
  if (!element) throw new Error(`Missing select: ${id}`)
  await act(async () => {
    element.value = value
    element.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function profileStatuses(
  connections: Partial<Record<ConnectorHarness, ConnectorConnection>> = {},
) {
  status.mockImplementation((harness = 'codex') =>
    Promise.resolve({
      ok: true,
      value: {
        ...initial,
        connection: connections[harness] ?? null,
        profiles: Object.values(connections).map((value) => ({
          harness: value.harness,
          connection: value,
        })),
      },
    }),
  )
  connect.mockImplementation((input) =>
    Promise.resolve({
      ok: true,
      value: {
        ...connection,
        harness: input.harness ?? 'codex',
        baseUrl: input.url,
        credentialMode: input.harness === 'opencode' ? 'config' : 'helper',
        protocol:
          input.harness === 'hermes' || input.harness === 'openclaw' ?
            'chat-completions'
          : 'anthropic-messages',
        catalogMode: input.harness === 'codex' ? 'remote' : 'configured',
      },
    }),
  )
}

describe('standalone connector UI', () => {
  test('packages a newer connector version without changing its installation identity', () => {
    expect(Bun.semver.satisfies(manifest.version, '>2.7.0')).toBe(true)
    expect(connectorBuilder.appId).toBe('com.copilot-api.connector')
    expect(connectorBuilder.productName).toBe('Copilot API Connector')
    expect(manifest.name).toBe('copilot-api-connector')
    expect(connectorBuilder.win.artifactName).toBe(
      'Copilot.API.Connector.Setup.${version}.${ext}',
    )
  })

  test('shows the actual connector version independently of the harness version', async () => {
    await render()
    expect(container.textContent).toContain('Connector version 2.7.1')
    expect(container.textContent).not.toContain('Connector version 0.160.0')
  })

  test('shows damaged saved-profile errors without invalid nested paragraphs', async () => {
    status.mockResolvedValueOnce({
      ok: true,
      value: {
        ...initial,
        profiles: [
          {
            harness: 'openclaw',
            connection: null,
            error: 'Saved OpenClaw profile needs repair.',
          },
        ],
      },
    })
    await render()
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toBe('Saved OpenClaw profile needs repair.')
    expect(alert?.parentElement?.tagName).toBe('DIV')
  })

  test('offers all harnesses and clears credentials, discovery and Undo confirmation when switching', async () => {
    profileStatuses({ codex: connection })
    await render()
    expect(
      container.querySelectorAll('#connector-harness option'),
    ).toHaveLength(5)
    await fill('gateway-key', 'codex-only-draft-key')
    await click('Show key')
    await click('Undo connection')
    await choose('connector-harness', 'claude-code')
    expect(status).toHaveBeenLastCalledWith('claude-code')
    expect(
      container.querySelector<HTMLInputElement>('#gateway-key')?.value,
    ).toBe('')
    expect(
      container.querySelector<HTMLInputElement>('#gateway-key')?.type,
    ).toBe('password')
    expect(button('Connect Claude Code').disabled).toBe(true)
    expect(container.textContent).not.toContain('codex-only-draft-key')
    expect(container.textContent).not.toContain('Undo this connection?')
    await choose('connector-harness', 'codex')
    expect(
      container.querySelector<HTMLInputElement>('#gateway-url')?.value,
    ).toBe(connection.baseUrl)
    expect(container.textContent).toContain('Codex connected')
  })

  test('reuses a saved gateway without implicitly returning its key to the renderer', async () => {
    profileStatuses({ codex: connection })
    await render()
    await choose('connector-harness', 'hermes')
    await choose('saved-gateway', 'codex')
    expect(
      container.querySelector<HTMLInputElement>('#gateway-url')?.readOnly,
    ).toBe(true)
    expect(
      container.querySelector<HTMLInputElement>('#gateway-key')?.disabled,
    ).toBe(true)
    expect(button('Connect Hermes Agent').disabled).toBe(false)
    await click('Connect Hermes Agent')
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        harness: 'hermes',
        url: connection.baseUrl,
        apiKey: '',
        copyFrom: 'codex',
      }),
    )
    expect(container.textContent).toContain('Hermes Agent connected')
    expect(container.textContent).toContain('chat-completions')
    expect(
      container.querySelector<HTMLInputElement>('#gateway-key')?.value,
    ).toBe('')
    expect(revealKey).not.toHaveBeenCalled()
  })

  test('requires explicit readable-key consent for OpenCode and still allows discovery before consent', async () => {
    profileStatuses()
    await render()
    await choose('connector-harness', 'opencode')
    await fill('gateway-url', connection.baseUrl)
    await fill('gateway-key', 'fixture-opencode-key')
    expect(button('Connect OpenCode').disabled).toBe(true)
    expect(button('Discover models').disabled).toBe(false)
    const checkbox = container.querySelector<HTMLInputElement>(
      'input[type=checkbox]',
    )
    if (!checkbox) throw new Error('Missing readable-key consent')
    await act(async () => checkbox.click())
    expect(button('Connect OpenCode').disabled).toBe(false)
    await click('Connect OpenCode')
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        harness: 'opencode',
        apiKey: 'fixture-opencode-key',
        allowPlaintext: true,
      }),
    )
    expect(container.textContent).toContain('readable in its configuration')
    await choose('connector-harness', 'openclaw')
    expect(container.querySelector('input[type=checkbox]')).toBeNull()
  })

  test('targets Sync and Undo only at the selected saved profile', async () => {
    const saved: ConnectorConnection = {
      ...connection,
      harness: 'openclaw',
      baseUrl: 'https://different.example',
      catalogMode: 'configured',
      protocol: 'chat-completions',
      credentialMode: 'helper',
    }
    profileStatuses({ codex: connection, openclaw: saved })
    refresh.mockImplementation(() =>
      Promise.resolve({ ok: true, value: saved }),
    )
    await render()
    await choose('connector-harness', 'openclaw')
    expect(
      container.querySelector<HTMLInputElement>('#gateway-url')?.value,
    ).toBe(saved.baseUrl)
    await click('Sync models')
    expect(refresh).toHaveBeenLastCalledWith('openclaw')
    await click('Undo connection')
    await click('Undo connection')
    expect(undo).toHaveBeenLastCalledWith('openclaw')
    await choose('connector-harness', 'codex')
    expect(container.textContent).toContain('Codex connected')
  })

  test('uses only two required inputs and has no gateway hosting controls', async () => {
    await render()
    expect(container.querySelectorAll('input[required]')).toHaveLength(2)
    expect(button('Connect Codex').disabled).toBe(true)
    expect(container.textContent).toContain(
      'No local gateway or Copilot sign-in required',
    )
    expect(container.textContent).toContain('two small inference checks')
    expect(container.textContent).not.toContain('Start server')
    expect(container.querySelector('#gateway-key')?.getAttribute('type')).toBe(
      'password',
    )
    expect(
      container.querySelector<HTMLDetailsElement>('#connector-advanced')?.open,
    ).toBe(false)
    expect(button('Select Codex executable').closest('details')?.id).toBe(
      'connector-advanced',
    )
    expect(container.textContent).toContain('Detected')
    expect(
      container.querySelector('label[for="connector-theme"]')?.textContent,
    ).toBe('Theme')
  })

  test('connects with URL and key, clears the key and explains persistent helper use', async () => {
    await render()
    await fill('gateway-url', connection.baseUrl)
    await fill('gateway-key', 'fixture-key')
    expect(button('Connect Codex').disabled).toBe(false)
    await click('Connect Codex')
    expect(connect).toHaveBeenCalledWith({
      harness: 'codex',
      copyFrom: undefined,
      allowPlaintext: false,
      url: connection.baseUrl,
      apiKey: 'fixture-key',
      model: undefined,
    })
    expect(
      container.querySelector<HTMLInputElement>('#gateway-key')?.value,
    ).toBe('')
    expect(container.textContent).toContain('Codex connected')
    expect(container.textContent).toContain('Keep the connector installed')
    expect(container.textContent).not.toContain('fixture-key')
  })

  test('reveals a saved key only on request and clears it on Hide key and window blur', async () => {
    profileStatuses({ codex: connection })
    await render()
    const field = container.querySelector<HTMLInputElement>('#gateway-key')
    expect(field?.value).toBe('')
    expect(field?.placeholder).toContain('Saved key')
    expect(revealKey).not.toHaveBeenCalled()
    await click('Show key')
    expect(revealKey).toHaveBeenCalledWith('codex')
    expect(field?.type).toBe('text')
    expect(field?.value).toBe('synthetic-saved-key')
    expect(win.localStorage.length).toBe(0)
    await click('Hide key')
    expect(field?.value).toBe('')
    expect(field?.type).toBe('password')
    await click('Show key')
    await act(async () => win.dispatchEvent(new win.Event('blur')))
    expect(field?.value).toBe('')
    expect(field?.type).toBe('password')
    expect(button('Show key').getAttribute('aria-pressed')).toBe('false')
  })

  test('keeps replacement keys when masking and never fetches the saved key for a draft', async () => {
    profileStatuses({ codex: connection })
    await render()
    await fill('gateway-key', 'synthetic-replacement-key')
    await click('Show key')
    await click('Hide key')
    expect(revealKey).not.toHaveBeenCalled()
    expect(
      container.querySelector<HTMLInputElement>('#gateway-key')?.value,
    ).toBe('synthetic-replacement-key')
  })

  test('reveals only the explicitly reused profile and clears it when switching harnesses', async () => {
    profileStatuses({ codex: connection })
    await render()
    await choose('connector-harness', 'hermes')
    await choose('saved-gateway', 'codex')
    await click('Show key')
    expect(revealKey).toHaveBeenLastCalledWith('codex')
    expect(
      container.querySelector<HTMLInputElement>('#gateway-key')?.value,
    ).toBe('synthetic-saved-key')
    await choose('connector-harness', 'claude-code')
    expect(
      container.querySelector<HTMLInputElement>('#gateway-key')?.value,
    ).toBe('')
    expect(container.querySelector('#gateway-key')?.getAttribute('type')).toBe(
      'password',
    )
  })

  test('reconnects and discovers using the saved key without revealing it', async () => {
    profileStatuses({ codex: connection })
    await render()
    await click('Discover models')
    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: '', copyFrom: 'codex' }),
    )
    await click('Connect Codex')
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: '', copyFrom: 'codex' }),
    )
    expect(revealKey).not.toHaveBeenCalled()
  })

  test('does not treat a revealed saved key as a replacement or send it to another URL', async () => {
    profileStatuses({ codex: connection })
    await render()
    await click('Show key')
    await fill('gateway-url', 'https://different.example')
    expect(button('Connect Codex').disabled).toBe(true)
    expect(button('Discover models').disabled).toBe(true)
    expect(
      container.querySelector<HTMLInputElement>('#gateway-key')?.value,
    ).toBe('')
    await fill('gateway-key', 'synthetic-different-key')
    await click('Connect Codex')
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'synthetic-different-key',
        copyFrom: undefined,
        url: 'https://different.example',
      }),
    )
  })

  test('surfaces saved-key failures and never exposes a late result after window blur', async () => {
    profileStatuses({ codex: connection })
    revealKey.mockResolvedValueOnce({
      ok: false,
      error: 'The saved gateway key cannot be decrypted.',
    })
    await render()
    await click('Show key')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'cannot be decrypted',
    )
    expect(container.querySelector('#gateway-key')?.getAttribute('type')).toBe(
      'password',
    )
    let finish:
      | ((result: Awaited<ReturnType<ConnectorAPI['revealKey']>>) => void)
      | undefined
    revealKey.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await click('Show key')
    expect(container.textContent).toContain('Retrieving the saved key')
    await act(async () => win.dispatchEvent(new win.Event('blur')))
    await act(async () => finish?.({ ok: true, value: 'synthetic-late-key' }))
    expect(
      container.querySelector<HTMLInputElement>('#gateway-key')?.value,
    ).toBe('')
    expect(button('Show key').disabled).toBe(false)
  })

  test('confirms repair, preserves ordinary Connect behavior, and clears revealed secrets after repair', async () => {
    profileStatuses({ codex: connection })
    connect.mockResolvedValueOnce({
      ok: false,
      error:
        'Connector-managed Codex settings were edited outside the connector.',
    })
    await render()
    await click('Connect Codex')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'edited outside',
    )
    await click('Repair connection')
    expect(repair).not.toHaveBeenCalled()
    expect(container.textContent).toContain('unrelated settings')
    expect(container.textContent).toContain('Backups may contain secrets')
    await click('Cancel')
    expect(repair).not.toHaveBeenCalled()
    await click('Show key')
    await click('Repair connection')
    await click('Back up and reconnect')
    expect(repair).toHaveBeenCalledWith(
      expect.objectContaining({
        harness: 'codex',
        copyFrom: 'codex',
        apiKey: '',
      }),
    )
    expect(container.textContent).toContain('Connection repaired')
    expect(
      container.querySelector<HTMLInputElement>('#gateway-key')?.value,
    ).toBe('')
    expect(container.querySelector('#gateway-key')?.getAttribute('type')).toBe(
      'password',
    )
  })

  test('repairs only the selected harness with an explicit replacement key and reports failures', async () => {
    profileStatuses({
      codex: connection,
      hermes: { ...connection, harness: 'hermes' },
    })
    repair.mockResolvedValueOnce({
      ok: false,
      error: 'Backup could not be written.',
    })
    await render()
    await choose('connector-harness', 'hermes')
    await fill('gateway-key', 'synthetic-rotated-key')
    await click('Repair connection')
    await click('Back up and reconnect')
    expect(repair).toHaveBeenCalledWith(
      expect.objectContaining({
        harness: 'hermes',
        apiKey: 'synthetic-rotated-key',
        copyFrom: undefined,
      }),
    )
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Backup could not be written',
    )
    expect(container.textContent).not.toContain('Connection repaired')
    await click('Cancel')
    await click('Repair connection')
    await choose('connector-harness', 'codex')
    expect(container.textContent).not.toContain('Repair this connection?')
  })

  test('discovers models without applying configuration and accepts explicit selection', async () => {
    await render()
    await fill('gateway-url', connection.baseUrl)
    await fill('gateway-key', 'fixture-key')
    await click('Discover models')
    expect(connect).not.toHaveBeenCalled()
    expect(container.textContent).toContain('1 discovered models were excluded')
    const selectModel =
      container.querySelector<HTMLSelectElement>('#default-model')
    if (!selectModel) throw new Error('Missing model selector')
    await act(async () => {
      selectModel.value = 'claude-test'
      selectModel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await click('Connect Codex')
    expect(connect).toHaveBeenCalledWith({
      harness: 'codex',
      copyFrom: undefined,
      allowPlaintext: false,
      url: connection.baseUrl,
      apiKey: 'fixture-key',
      model: 'claude-test',
    })
  })

  test('disables setup without secure storage or Codex and offers executable selection', async () => {
    status.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        value: { ...initial, installation: null, secureStorage: false },
      }),
    )
    await render()
    await fill('gateway-url', connection.baseUrl)
    await fill('gateway-key', 'fixture-key')
    expect(button('Connect Codex').disabled).toBe(true)
    expect(container.textContent).toContain('each key using OS encryption')
    await click('Install or update Codex')
    expect(installGuide).toHaveBeenCalledTimes(1)
    expect(connect).not.toHaveBeenCalled()
    const advanced = container.querySelector<HTMLDetailsElement>(
      '#connector-advanced',
    )
    if (!advanced) throw new Error('Missing advanced disclosure')
    advanced.open = true
    await click('Select Codex executable')
    expect(select).toHaveBeenCalledTimes(1)
    expect(button('Connect Codex').disabled).toBe(false)
  })

  test('returns to automatic detection without changing the saved connection', async () => {
    status.mockImplementation(() =>
      Promise.resolve({ ok: true, value: { ...initial, connection } }),
    )
    reset.mockImplementation(() =>
      Promise.resolve({ ok: true, value: { ...initial, connection } }),
    )
    await render()
    await click('Use automatic detection')
    expect(reset).toHaveBeenCalledTimes(1)
    expect(connect).not.toHaveBeenCalled()
    expect(undo).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Codex connected')
  })

  test('persists light and dark preferences and restores them after remount', async () => {
    await render()
    const theme = container.querySelector<HTMLSelectElement>('#connector-theme')
    if (!theme) throw new Error('Missing theme selector')
    for (const preference of ['dark', 'light']) {
      await act(async () => {
        theme.value = preference
        theme.dispatchEvent(new Event('change', { bubbles: true }))
      })
      expect(document.documentElement.classList.contains('dark')).toBe(
        preference === 'dark',
      )
      expect(win.localStorage.getItem('copilot-api-connector-theme')).toBe(
        preference,
      )
    }
    await render('remount')
    expect(
      container.querySelector<HTMLSelectElement>('#connector-theme')?.value,
    ).toBe('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  test('follows system changes only when the System theme is selected', async () => {
    await render()
    await act(async () => {
      win.happyDOM.settings.device.prefersColorScheme = 'dark'
      win.dispatchEvent(new win.Event('resize'))
    })
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    const theme = container.querySelector<HTMLSelectElement>('#connector-theme')
    if (!theme) throw new Error('Missing theme selector')
    await act(async () => {
      theme.value = 'light'
      theme.dispatchEvent(new Event('change', { bubbles: true }))
      win.dispatchEvent(new win.Event('resize'))
    })
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  test('reports invalid stored themes and preference write failures explicitly', async () => {
    win.localStorage.setItem('copilot-api-connector-theme', 'invalid-fixture')
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'could not be read',
    )
    Object.defineProperty(win.localStorage, 'setItem', {
      value: () => {
        throw new Error('Fixture storage unavailable')
      },
    })
    const theme = container.querySelector<HTMLSelectElement>('#connector-theme')
    if (!theme) throw new Error('Missing theme selector')
    await act(async () => {
      theme.value = 'dark'
      theme.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'could not be saved',
    )
    expect(theme.value).toBe('auto')
  })

  test('surfaces failures instead of claiming a successful connection', async () => {
    connect.mockImplementation(() =>
      Promise.resolve({ ok: false, error: 'Gateway authentication failed.' }),
    )
    await render()
    await fill('gateway-url', connection.baseUrl)
    await fill('gateway-key', 'fixture-key')
    await click('Connect Codex')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Gateway authentication failed.',
    )
    expect(container.textContent).not.toContain('Codex connected')
  })

  test('syncs a saved connection without re-entering its key and confirms undo', async () => {
    status.mockImplementation(() =>
      Promise.resolve({ ok: true, value: { ...initial, connection } }),
    )
    await render()
    expect(
      container.querySelector<HTMLInputElement>('#gateway-url')?.value,
    ).toBe(connection.baseUrl)
    await click('Sync models')
    expect(refresh).toHaveBeenCalledTimes(1)
    await click('Undo connection')
    expect(undo).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Close Codex sessions first')
    await click('Cancel')
    expect(undo).not.toHaveBeenCalled()
    await click('Undo connection')
    await click('Undo connection')
    expect(undo).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Connection removed')
  })

  test('supports revealing the key and Chinese localization', async () => {
    await render()
    await click('Show key')
    expect(container.querySelector('#gateway-key')?.getAttribute('type')).toBe(
      'text',
    )
    await click('Hide key')
    expect(container.querySelector('#gateway-key')?.getAttribute('type')).toBe(
      'password',
    )
    const language = container.querySelector<HTMLSelectElement>(
      '#connector-language',
    )
    if (!language) throw new Error('Missing language selector')
    await act(async () => {
      language.value = 'zh'
      language.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.textContent).toContain('连接 Codex')
  })

  test('does not use a browser-only success fallback', async () => {
    Reflect.deleteProperty(win, 'connectorAPI')
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'must run in its desktop application',
    )
    expect(button('Connect Codex').disabled).toBe(true)
    expect(connect).not.toHaveBeenCalled()
  })
})
