import { useEffect, useRef, useState } from 'react'
import type {
  AppConfigurationPreview,
  AppConfigurationStatus,
  ConfigurableApp,
} from '@modelbridge/runtime/apps'
import type { AvailableModel, Role } from '@modelbridge/runtime/contracts'
import { apps, protocolLabels, protocolPaths, type AppInfo } from './apps'
import { CodexPanel } from './CodexPanel'
import { failure, formatDuration, formatPremium, plural } from './format'
import {
  CopyButton,
  copyText,
  probe,
  send,
  type ProbeResult,
} from './gateway-client'
import { gatewayBase, type PlaygroundPreset } from './Playground'
import { curlSnippet, probeRequest, pythonSnippet } from './chat-protocol'
import type { AppStatus, Result } from './types'

export type TryPreset = Omit<PlaygroundPreset, 'nonce'>

const configurable = (id: string): id is ConfigurableApp =>
  id === 'claude-code' || id === 'hermes' || id === 'openclaw'

const multiplier = (model: AvailableModel) => model.premiumMultiplier ?? 0

const cost = (model: AvailableModel) =>
  model.premiumMultiplier === undefined ? ''
  : model.premiumMultiplier === 0 ? 'free'
  : `×${formatPremium(model.premiumMultiplier)}`

// Cheapest first so tests default to models that use no premium requests.
const byCost = (models: AvailableModel[]) =>
  [...models].sort((left, right) => multiplier(left) - multiplier(right))

export function AppsPanel({
  status,
  role,
  onTry,
}: {
  status: AppStatus
  role: Role
  onTry: (preset: TryPreset) => void
}) {
  const [appId, setAppId] = useState(apps[0].id)
  const info = apps.find((item) => item.id === appId) ?? apps[0]
  const models = status.models.filter((model) =>
    model.protocols.includes(info.protocol),
  )
  const base =
    info.protocol === 'messages' ?
      gatewayBase(status.localUrl)
    : status.localUrl
  return (
    <section className="apps">
      <h2>Apps</h2>
      <p className="muted">
        Use ModelBridge from any coding tool. Pick an app, set it up, then test
        it end to end.
      </p>
      <label className="app-picker">
        App
        <select
          value={appId}
          onChange={(event) => {
            const next = apps.find((item) => item.id === event.target.value)
            if (next) setAppId(next.id)
          }}
        >
          {apps.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">
        {info.description} Speaks {protocolLabels[info.protocol]}.{' '}
        {info.automatic ?
          'ModelBridge can set it up for you.'
        : 'Copy the details below into its settings.'}
      </p>
      <ConnectionDetails info={info} base={base} models={models} />
      {info.id === 'codex' ?
        <div className="app-card">
          <CodexPanel models={status.models} />
        </div>
      : configurable(info.id) ?
        <HarnessSetup key={info.id} app={info.id} info={info} models={models} />
      : <ManualSetup
          key={info.id}
          info={info}
          origin={gatewayBase(status.localUrl)}
          models={models}
        />
      }
      <ConnectionTest
        key={info.id}
        info={info}
        status={status}
        role={role}
        models={models}
        onTry={onTry}
      />
    </section>
  )
}

function ConnectionDetails({
  info,
  base,
  models,
}: {
  info: AppInfo
  base: string
  models: AvailableModel[]
}) {
  return (
    <div className="app-card">
      <h3>Connection details</h3>
      <dl className="details">
        <dt>
          {info.protocol === 'messages' ? 'Base URL (no /v1)' : 'Base URL'}
        </dt>
        <dd>
          <code>{base}</code>
          <CopyButton copy={copyText(base)} />
        </dd>
        <dt>API key</dt>
        <dd>
          <span className="muted">This machine’s local key</span>
          <CopyButton
            label="Copy key"
            copy={() => window.modelbridge.copyKey(false)}
          />
        </dd>
        <dt>Endpoint</dt>
        <dd>
          <code>POST {protocolPaths[info.protocol]}</code>
          <span className="muted">{protocolLabels[info.protocol]}</span>
        </dd>
        <dt>Models</dt>
        <dd>
          {models.length ?
            <>
              {plural(models.length, 'model')}, for example{' '}
              <code>{models[0].id}</code>
            </>
          : <span className="muted">
              None yet. Add a host or Copilot account first.
            </span>
          }
        </dd>
      </dl>
      <p className="muted">
        The key only works on this machine (127.0.0.1); it never reaches the
        internet. ModelBridge forwards each request to the model’s source.
        {info.protocol === 'messages' ?
          ' The key works as either an x-api-key header or a Bearer token.'
        : ''}
      </p>
      {models.length > 0 && (
        <details>
          <summary>All model IDs ({models.length})</summary>
          <ul className="model-ids">
            {models.map((model) => (
              <li key={model.id}>
                <code>{model.id}</code>
                <span className="muted">
                  {model.name} · {model.sourceLabel}
                  {cost(model) && ` · ${cost(model)}`}
                </span>
                <CopyButton copy={copyText(model.id)} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

function HarnessSetup({
  app,
  info,
  models,
}: {
  app: ConfigurableApp
  info: AppInfo
  models: AvailableModel[]
}) {
  const [state, setState] = useState<AppConfigurationStatus | null>(null)
  const [preview, setPreview] = useState<AppConfigurationPreview | null>(null)
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  async function run<T>(
    operation: () => Promise<Result<T>>,
    accept: (value: T) => void,
  ) {
    setBusy(true)
    setError('')
    try {
      const result = await operation()
      if (result.ok) accept(result.value)
      else setError(result.error)
    } catch (reason) {
      setError(failure(reason, `${info.name} setup failed.`))
    } finally {
      setBusy(false)
    }
  }
  const modelKey = models.map((item) => item.id).join('\n')
  useEffect(() => {
    void window.modelbridge
      .appConfigStatus(app)
      .then((result) => {
        if (result.ok) setState(result.value)
        else setError(result.error)
      })
      .catch((reason: unknown) =>
        setError(failure(reason, `Could not read ${info.name} settings.`)),
      )
  }, [app, info.name, modelKey])
  const current = models.find(
    (item) =>
      item.id === state?.model || `modelbridge/${item.id}` === state?.model,
  )
  const selected =
    models.some((item) => item.id === model) ? model : (
      (current?.id ?? models[0]?.id ?? '')
    )
  const label =
    state?.error ? 'Unreadable'
    : state?.configured ? 'Uses ModelBridge'
    : state?.externalEdit ? 'Changed outside ModelBridge'
    : state?.exists ? 'Not set up'
    : 'No settings file yet'
  return (
    <div className="app-card">
      <h3>Set up {info.name}</h3>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      <p>
        Settings file: <code>{state?.configPath ?? 'Inspecting…'}</code>{' '}
        <span
          className={`badge ${
            state?.configured ? 'ok'
            : state?.error || state?.externalEdit ? 'near'
            : ''
          }`}
        >
          {label}
        </span>
      </p>
      {state?.error && (
        <div className="notice warn" role="status">
          {state.error} Fix the file, then come back; ModelBridge never
          overwrites a file it cannot read.
        </div>
      )}
      {state?.missingModel && (
        <div className="notice warn" role="status">
          The default model ModelBridge set is no longer available. Choose
          another model and apply again.
        </div>
      )}
      {state?.externalEdit && (
        <div className="notice warn" role="status">
          ModelBridge’s settings were changed outside the app. Apply again to
          put them back, or restore your original settings.
        </div>
      )}
      <p>
        Current default model: <code>{state?.model ?? 'not set'}</code>
      </p>
      <form
        className="actions"
        onSubmit={(event) => {
          event.preventDefault()
          setDone('')
          void run(
            () => window.modelbridge.previewAppConfig(app, selected),
            setPreview,
          )
        }}
      >
        <label>
          Default model
          <select
            required
            value={selected}
            onChange={(event) => setModel(event.target.value)}
          >
            {!models.length && (
              <option value="">Add a host or Copilot account first</option>
            )}
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} / {item.sourceLabel}
                {cost(item) && ` (${cost(item)})`}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" disabled={busy || !selected}>
          {state?.configured ? 'Preview update' : 'Preview changes'}
        </button>
        <button
          type="button"
          disabled={busy || !state?.canRestore}
          onClick={() => {
            setDone('')
            void run(
              () => window.modelbridge.previewAppRestore(app),
              setPreview,
            )
          }}
        >
          Preview restore
        </button>
      </form>
      {done && (
        <p role="status" className="notice">
          {done}
        </p>
      )}
      {preview && (
        <div className="preview">
          <h4>
            {preview.action === 'restore' ?
              `Restore ${info.name}’s original settings`
            : `Point ${info.name} at ModelBridge`}
            : review before applying
          </h4>
          <ul>
            {preview.changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
          {preview.warnings.map((warning) => (
            <div className="notice warn" role="status" key={warning}>
              {warning}
            </div>
          ))}
          <div className="config-diff">
            <div>
              <h4>Current (secrets hidden)</h4>
              <pre>{preview.before || '(No settings file)'}</pre>
            </div>
            <div>
              <h4>Proposed (secrets hidden)</h4>
              <pre>{preview.after || '(File removed)'}</pre>
            </div>
          </div>
          <div className="actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void run(
                  () => window.modelbridge.applyAppConfig(preview.id),
                  (value) => {
                    setState(value)
                    setPreview(null)
                    setDone(
                      preview.action === 'restore' ?
                        `Restored ${info.name}’s original settings.`
                      : `Saved. Restart ${info.name} (or start a new session) to use ModelBridge, then run Test connection below.`,
                    )
                  },
                )
              }
            >
              {preview.action === 'restore' ? 'Restore' : 'Apply'}
            </button>
            <button disabled={busy} onClick={() => setPreview(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function ManualSetup({
  info,
  origin,
  models,
}: {
  info: AppInfo
  origin: string
  models: AvailableModel[]
}) {
  const [language, setLanguage] = useState<'curl' | 'python'>('curl')
  const model = byCost(models)[0]
  const request = model ? probeRequest(info.protocol, model) : null
  const snippet =
    !request ? ''
    : language === 'curl' ? curlSnippet(origin, info.protocol, request)
    : pythonSnippet(origin, info.protocol, request)
  return (
    <div className="app-card">
      <h3>Set up {info.name}</h3>
      <ol className="steps-list">
        <li>
          Choose the{' '}
          {info.protocol === 'messages' ?
            'Anthropic-compatible'
          : 'OpenAI-compatible'}{' '}
          or custom provider option in the tool’s settings.
        </li>
        <li>Paste the Base URL and API key from Connection details.</li>
        <li>Enter a model ID from the list, including its source prefix.</li>
      </ol>
      {request && (
        <>
          <div className="segmented" role="group" aria-label="Snippet">
            {(['curl', 'python'] as const).map((item) => (
              <button
                key={item}
                aria-pressed={language === item}
                onClick={() => setLanguage(item)}
              >
                {item === 'curl' ? 'curl' : 'Python'}
              </button>
            ))}
          </div>
          <pre>{snippet}</pre>
          <div className="actions">
            <CopyButton label="Copy snippet" copy={copyText(snippet)} />
            <span>Replace the key placeholder with the copied key.</span>
          </div>
        </>
      )}
    </div>
  )
}

type StepState = 'pending' | 'running' | 'ok' | 'failed' | 'skipped'
interface Step {
  id: string
  label: string
  state: StepState
  detail: string
}

const stepIcons: Record<StepState, string> = {
  pending: '○',
  running: '…',
  ok: '✓',
  failed: '✕',
  skipped: '–',
}

async function configured(info: AppInfo): Promise<string> {
  if (info.id === 'codex') {
    const result = await window.modelbridge.codexStatus()
    if (!result.ok) throw new Error(result.error)
    if (!result.value.active)
      throw new Error('Not set up yet. Use Set up Codex above.')
    if (result.value.externalManagedEdit)
      throw new Error('Codex settings were changed outside ModelBridge.')
    return `Default model ${result.value.effective.model}`
  }
  if (!configurable(info.id)) return 'Configured manually'
  const result = await window.modelbridge.appConfigStatus(info.id)
  if (!result.ok) throw new Error(result.error)
  if (result.value.error) throw new Error(result.value.error)
  if (!result.value.configured)
    throw new Error(
      result.value.externalEdit ?
        'Settings were changed outside ModelBridge.'
      : `Not set up yet. Use Set up ${info.name} above.`,
    )
  return `Default model ${result.value.model ?? 'not set'}`
}

function ConnectionTest({
  info,
  status,
  role,
  models,
  onTry,
}: {
  info: AppInfo
  status: AppStatus
  role: Role
  models: AvailableModel[]
  onTry: (preset: TryPreset) => void
}) {
  const [steps, setSteps] = useState<Step[]>([])
  const [running, setRunning] = useState(false)
  const [modelId, setModelId] = useState('')
  const ordered = byCost(models)
  const model = ordered.find((item) => item.id === modelId) ?? ordered[0]
  const remotes = status.sources.filter((source) => source.kind === 'remote')

  async function test() {
    if (running) return
    setRunning(true)
    const plan: Array<Omit<Step, 'state' | 'detail'>> = [
      { id: 'gateway', label: 'Local gateway is running' },
      { id: 'models', label: 'Key accepted and models listed' },
      ...(role === 'client' ?
        remotes.map((source) => ({
          id: `host:${source.id}`,
          label: `Host “${source.label}” is reachable`,
        }))
      : []),
      ...(info.automatic ?
        [{ id: 'config', label: `${info.name} is set up` }]
      : []),
      {
        id: 'probe',
        label:
          model ?
            `${model.name} answers on ${protocolLabels[info.protocol]}`
          : 'A model answers',
      },
    ]
    setSteps(plan.map((step) => ({ ...step, state: 'pending', detail: '' })))
    const update = (id: string, patch: Partial<Step>) =>
      setSteps((current) =>
        current.map((step) => (step.id === id ? { ...step, ...patch } : step)),
      )
    const step = async (id: string, action: () => Promise<string>) => {
      update(id, { state: 'running' })
      try {
        update(id, { state: 'ok', detail: await action() })
        return true
      } catch (reason) {
        update(id, { state: 'failed', detail: failure(reason, 'Failed.') })
        return false
      }
    }
    try {
      const up = await step('gateway', async () => {
        const { result } = await send('/health')
        if (result.status !== 200) throw new Error(`HTTP ${result.status}`)
        return `Answered in ${formatDuration(result.durationMs)}`
      })
      if (!up) {
        setSteps((current) =>
          current.map((item) =>
            item.state === 'pending' ?
              {
                ...item,
                state: 'skipped',
                detail: 'Skipped: the local gateway is not answering.',
              }
            : item,
          ),
        )
        return
      }
      await step('models', async () => {
        const { result, body } = await send('/v1/models')
        if (result.status !== 200)
          throw new Error(`HTTP ${result.status}: ${body.slice(0, 200)}`)
        const parsed: unknown = JSON.parse(body)
        const data =
          parsed && typeof parsed === 'object' && 'data' in parsed ?
            parsed.data
          : null
        const total = Array.isArray(data) ? data.length : 0
        if (!models.length)
          throw new Error(
            `${plural(total, 'model')} listed, but none serve ${protocolLabels[info.protocol]}.`,
          )
        return `${plural(total, 'model')} listed; ${models.length} serve ${protocolLabels[info.protocol]}`
      })
      for (const source of role === 'client' ? remotes : [])
        await step(`host:${source.id}`, async () => {
          const result = await window.modelbridge.refreshSource(source.id)
          if (!result.ok) throw new Error(result.error)
          const health = result.value.sourceHealth[source.id]
          if (health && !health.ok)
            throw new Error(health.message ?? 'The host did not answer.')
          return health?.message ?? 'Answered through the tunnel'
        })
      if (info.automatic) await step('config', () => configured(info))
      await step('probe', async () => {
        if (!model) throw new Error('No model serves this app’s API.')
        const result = await probe(info.protocol, model)
        if (!result.ok) throw new Error(result.detail)
        return `${result.detail} in ${formatDuration(result.durationMs)}`
      })
    } finally {
      setRunning(false)
    }
  }

  const passed = steps.filter((step) => step.state === 'ok').length
  const failed = steps.some((step) => step.state === 'failed')
  return (
    <div className="app-card">
      <h3>Test connection</h3>
      <p className="muted">
        Checks every hop {info.name} uses: the local gateway, your key,
        {role === 'client' ? ' each host tunnel,' : ''} its settings, and one
        real reply. Test requests show as Playground on the Dashboard.
      </p>
      <div className="actions">
        <label>
          Test with
          <select
            value={model?.id ?? ''}
            onChange={(event) => setModelId(event.target.value)}
          >
            {ordered.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} / {item.sourceLabel}
                {cost(item) && ` (${cost(item)})`}
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary"
          disabled={running}
          onClick={() => void test()}
        >
          {running ? 'Testing…' : 'Test connection'}
        </button>
        <button
          disabled={!model}
          onClick={() => onTry({ protocol: info.protocol, model: model?.id })}
        >
          Try in Playground
        </button>
      </div>
      {steps.length > 0 && (
        <>
          <ol className="checklist" aria-live="polite">
            {steps.map((step) => (
              <li key={step.id} className={`step ${step.state}`}>
                <span className="step-icon" aria-hidden="true">
                  {stepIcons[step.state]}
                </span>
                <span>
                  <strong>{step.label}</strong>
                  {step.detail && <span className="muted"> {step.detail}</span>}
                </span>
              </li>
            ))}
          </ol>
          {!running && (
            <p role="status" className={`badge ${failed ? 'over' : 'ok'}`}>
              {failed ?
                'Something needs attention: see the failed step.'
              : `All ${passed} checks passed. ${info.name} is ready.`}
            </p>
          )}
        </>
      )}
      <ModelSweep info={info} models={ordered} />
    </div>
  )
}

function ModelSweep({
  info,
  models,
}: {
  info: AppInfo
  models: AvailableModel[]
}) {
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [results, setResults] = useState<
    Record<string, ProbeResult | 'running'>
  >({})
  const [running, setRunning] = useState(false)
  const stopped = useRef(false)
  const selected = models.filter((model) => chosen.has(model.id))
  const premium = selected.reduce((sum, model) => sum + multiplier(model), 0)
  const unknown = selected.filter(
    (model) => model.premiumMultiplier === undefined,
  ).length
  const done = Object.values(results).filter((value) => value !== 'running')
  const answered = done.filter((value) => value.ok).length

  async function sweep() {
    setRunning(true)
    stopped.current = false
    setResults({})
    try {
      for (const model of selected) {
        if (stopped.current) break
        setResults((current) => ({ ...current, [model.id]: 'running' }))
        const result = await probe(info.protocol, model)
        setResults((current) => ({ ...current, [model.id]: result }))
      }
    } finally {
      setRunning(false)
    }
  }
  const toggle = (id: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  return (
    <details className="sweep">
      <summary>Test every model (optional)</summary>
      <p className="muted">
        Sends one short request per selected model on{' '}
        {protocolLabels[info.protocol]}. On Copilot each request uses premium
        requests at the model’s multiplier, so choose deliberately.
      </p>
      <div className="actions">
        <button
          disabled={running}
          onClick={() =>
            setChosen(
              new Set(
                models
                  .filter((model) => model.premiumMultiplier === 0)
                  .map((model) => model.id),
              ),
            )
          }
        >
          Select free models
        </button>
        <button
          disabled={running}
          onClick={() => setChosen(new Set(models.map((model) => model.id)))}
        >
          Select all
        </button>
        <button disabled={running} onClick={() => setChosen(new Set())}>
          Clear
        </button>
      </div>
      <ul className="sweep-list">
        {models.map((model) => {
          const result = results[model.id]
          return (
            <li key={model.id}>
              <label className="checkbox inline">
                <input
                  type="checkbox"
                  checked={chosen.has(model.id)}
                  disabled={running}
                  onChange={(event) => toggle(model.id, event.target.checked)}
                />
                {model.name}
                <span className="muted"> {model.sourceLabel}</span>
              </label>
              {cost(model) && <span className="badge info">{cost(model)}</span>}
              {result === 'running' ?
                <span className="muted">Testing…</span>
              : result ?
                <span className={`badge ${result.ok ? 'ok' : 'over'}`}>
                  {result.ok ?
                    `OK ${formatDuration(result.durationMs)}`
                  : 'Failed'}
                </span>
              : null}
              {result && result !== 'running' && !result.ok && (
                <span className="sweep-error">{result.detail}</span>
              )}
            </li>
          )
        })}
      </ul>
      <div className="actions">
        <button
          className="primary"
          disabled={running || !selected.length}
          onClick={() => void sweep()}
        >
          {running ? 'Testing…' : `Test ${plural(selected.length, 'model')}`}
        </button>
        {running && (
          <button
            onClick={() => {
              stopped.current = true
            }}
          >
            Stop after current
          </button>
        )}
        <span>
          Estimated cost: about {formatPremium(premium)} premium requests
          {unknown ? `, plus ${unknown} without a known multiplier` : ''}.
        </span>
      </div>
      {!running && done.length > 0 && (
        <p role="status">
          {answered} of {done.length} models answered.
        </p>
      )}
    </details>
  )
}
