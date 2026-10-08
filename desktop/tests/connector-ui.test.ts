import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { Window } from 'happy-dom'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import ConnectorApp from '../src/connector/App'
import { LanguageProvider } from '../src/contexts/LanguageContext'
import type {
  ConnectorAPI,
  ConnectorConnection,
  ConnectorDiscovery,
  ConnectorStatus,
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
let discover: ReturnType<typeof mock<ConnectorAPI['discover']>>
let refresh: ReturnType<typeof mock<ConnectorAPI['refresh']>>
let undo: ReturnType<typeof mock<ConnectorAPI['undo']>>
let select: ReturnType<typeof mock<ConnectorAPI['selectCodex']>>
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
  discover = mock(() => Promise.resolve({ ok: true, value: { ...discovery } }))
  refresh = mock(() => Promise.resolve({ ok: true, value: { ...connection } }))
  undo = mock(() => Promise.resolve({ ok: true, value: null }))
  select = mock(() => Promise.resolve({ ok: true, value: { ...initial } }))
  const api: ConnectorAPI = {
    status,
    connect,
    discover,
    refresh,
    undo,
    selectCodex: select,
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

async function render() {
  await act(async () =>
    root.render(
      createElement(LanguageProvider, {
        children: createElement(ConnectorApp),
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

describe('standalone connector UI', () => {
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
  })

  test('connects with URL and key, clears the key and explains persistent helper use', async () => {
    await render()
    await fill('gateway-url', connection.baseUrl)
    await fill('gateway-key', 'fixture-key')
    expect(button('Connect Codex').disabled).toBe(false)
    await click('Connect Codex')
    expect(connect).toHaveBeenCalledWith({
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
    expect(container.textContent).toContain(
      'Plaintext key storage is not supported',
    )
    await click('Select Codex executable')
    expect(select).toHaveBeenCalledTimes(1)
    expect(button('Connect Codex').disabled).toBe(false)
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
    const language = container.querySelector<HTMLSelectElement>('header select')
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
