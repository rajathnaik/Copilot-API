import { useEffect, useState } from 'react'
import type { SourceInput } from '@modelbridge/runtime/contracts'
import type { AppStatus, Result } from './types'
import icon from '../assets/icon.svg'
import { CodexPanel } from './CodexPanel'

const initialInput: SourceInput = {
  label: 'Remote Copilot host',
  kind: 'remote',
  baseUrl: '',
  protocol: 'responses',
  apiKey: '',
  shared: false,
}

export default function App() {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const copilotLogin = status?.copilotLogin
  const [input, setInput] = useState(initialInput)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revealed, setRevealed] = useState<{
    label: string
    key: string
  } | null>(null)
  useEffect(() => {
    let active = true
    const refresh = () => {
      void window.modelbridge
        .status()
        .then((result) => {
          if (!active) return
          if (result.ok) setStatus(result.value)
          else setError(result.error)
        })
        .catch((failure: unknown) => {
          if (active)
            setError(
              failure instanceof Error ?
                failure.message
              : 'Could not read runtime status.',
            )
        })
    }
    const clearKey = () => setRevealed(null)
    window.addEventListener('blur', clearKey)
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => {
      active = false
      clearInterval(timer)
      window.removeEventListener('blur', clearKey)
    }
  }, [])
  const run = async (
    operation: () => Promise<Result<AppStatus>>,
    clearInput = false,
  ) => {
    setBusy(true)
    setError('')
    setRevealed(null)
    try {
      const result = await operation()
      if (result.ok) {
        setStatus(result.value)
        if (clearInput) setInput(initialInput)
      } else setError(result.error)
    } catch (failure) {
      setError(
        failure instanceof Error ?
          failure.message
        : 'ModelBridge operation failed.',
      )
    } finally {
      setBusy(false)
    }
  }
  const reveal = async (remote: boolean) => {
    setError('')
    try {
      const result = await (remote ?
        window.modelbridge.remoteKey()
      : window.modelbridge.localKey())
      if (result.ok)
        setRevealed({
          label: remote ? 'Host access key' : 'Local gateway key',
          key: result.value,
        })
      else setError(result.error)
    } catch (failure) {
      setError(
        failure instanceof Error ?
          failure.message
        : 'Could not reveal the key.',
      )
    }
  }
  return (
    <main>
      <header>
        <img src={icon} alt="" width="48" height="48" />
        <div>
          <h1>ModelBridge</h1>
          <p>One hub. Local providers. Remote hosts.</p>
        </div>
        <span className="version">{status?.version ?? 'Starting'}</span>
      </header>
      <div className="notice">
        One application, two roles. Host your Copilot subscription here, or
        enter another host's URL and key and configure Codex. Direct Copilot
        integration follows the original repository; no Copilot SDK is used.
        Development build: real two-machine verification and installer
        publication are still pending.
      </div>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      {status?.transportError && (
        <div role="alert" className="error">
          {status.transportError}
        </div>
      )}
      {status?.copilotError && (
        <div role="alert" className="error">
          {status.copilotError}
        </div>
      )}
      <section>
        <h2>Host: GitHub Copilot subscription</h2>
        <p>
          Sign in with your existing Copilot subscription. ModelBridge obtains
          and refreshes Copilot tokens, discovers your available models, and
          forwards API requests directly, following the original gateway
          implementation. Coding tools run in the client harness, not on this
          host.
        </p>
        <div className="actions">
          <button
            className="primary"
            disabled={busy || !status || !!status.copilotLogin}
            onClick={() =>
              void run(() =>
                window.modelbridge.loginCopilot(
                  'My Copilot subscription',
                  true,
                ),
              )
            }
          >
            Sign in and discover Copilot models
          </button>
          {copilotLogin && (
            <button
              disabled={busy}
              onClick={() =>
                void run(() => window.modelbridge.cancelCopilotLogin())
              }
            >
              Cancel sign-in
            </button>
          )}
        </div>
        {copilotLogin && (
          <p>
            Open <code>{copilotLogin.url}</code> and enter{' '}
            <strong>{copilotLogin.code}</strong>. Discovery continues
            automatically after authorization.
            <button
              onClick={() =>
                void window.modelbridge
                  .openLogin(copilotLogin.url)
                  .then((result) => {
                    if (!result.ok) setError(result.error)
                  })
                  .catch((failure: unknown) =>
                    setError(
                      failure instanceof Error ?
                        failure.message
                      : 'Could not open GitHub sign-in.',
                    ),
                  )
              }
            >
              Open GitHub sign-in
            </button>
          </p>
        )}
      </section>
      <section>
        <h2>Local gateway</h2>
        <p>
          Your coding clients use a stable, authenticated endpoint on this
          machine.
        </p>
        <code>{status?.localUrl ?? 'Starting local runtime...'}</code>
        <div className="actions">
          <button disabled={!status || busy} onClick={() => void reveal(false)}>
            Show local key
          </button>
          <span>Closing the window keeps the hub running in the tray.</span>
        </div>
      </section>
      <section>
        <h2>Client: add a remote host or API source</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void run(() => window.modelbridge.addSource(input), true)
          }}
        >
          <label>
            Name
            <input
              required
              value={input.label}
              onChange={(event) =>
                setInput({ ...input, label: event.target.value })
              }
            />
          </label>
          <label>
            Source type
            <select
              value={input.kind}
              onChange={(event) =>
                setInput({
                  ...input,
                  kind: event.target.value === 'remote' ? 'remote' : 'api',
                })
              }
            >
              <option value="api">Provider API</option>
              <option value="remote">Remote ModelBridge host</option>
            </select>
          </label>
          <label className="wide">
            {input.kind === 'remote' ?
              'Remote host URL'
            : 'API base URL (including /v1 where required)'}
            <input
              required
              type="url"
              value={input.baseUrl}
              onChange={(event) =>
                setInput({ ...input, baseUrl: event.target.value })
              }
            />
          </label>
          {input.kind === 'api' && (
            <label>
              Native protocol
              <select
                value={input.protocol}
                onChange={(event) => {
                  const value = event.target.value
                  if (
                    value === 'responses'
                    || value === 'messages'
                    || value === 'chat-completions'
                  )
                    setInput({ ...input, protocol: value })
                }}
              >
                <option value="responses">OpenAI Responses</option>
                <option value="messages">Anthropic Messages</option>
                <option value="chat-completions">
                  OpenAI Chat Completions
                </option>
              </select>
            </label>
          )}
          <label>
            Access key
            <input
              required
              type="password"
              autoComplete="off"
              value={input.apiKey}
              onChange={(event) =>
                setInput({ ...input, apiKey: event.target.value })
              }
            />
          </label>
          <button className="primary" disabled={busy || !status} type="submit">
            {busy ? 'Working...' : 'Discover and add source'}
          </button>
        </form>
      </section>
      <section>
        <h2>Sources and models</h2>
        {!status?.sources.length && (
          <p>
            No sources configured. Add a provider API or remote ModelBridge host
            above.
          </p>
        )}
        {status?.sources.map((source) => (
          <div className="source" key={source.id}>
            <strong>{source.label}</strong>
            <span>
              {source.kind} · {source.models.length} models
            </span>
            <button
              disabled={busy}
              onClick={() =>
                void run(() => window.modelbridge.refreshSource(source.id))
              }
            >
              Refresh models
            </button>
            <label className="checkbox">
              <input
                type="checkbox"
                disabled={busy}
                checked={source.shared}
                onChange={(event) =>
                  void run(() =>
                    window.modelbridge.shareSource(
                      source.id,
                      event.target.checked,
                    ),
                  )
                }
              />
              Share remotely
            </label>
          </div>
        ))}
        {!!status?.models.length && (
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Source</th>
                <th>Native protocol</th>
                <th>Qualified model ID</th>
              </tr>
            </thead>
            <tbody>
              {status.models.map((model) => (
                <tr key={model.id}>
                  <td>{model.name}</td>
                  <td>{model.sourceLabel}</td>
                  <td>
                    {(
                      model.upstreamProtocol
                      && model.upstreamProtocol !== model.protocol
                    ) ?
                      `${model.protocol} via ${model.upstreamProtocol}`
                    : model.protocol}
                  </td>
                  <td>
                    <code>{model.id}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <CodexPanel models={status?.models ?? []} />
      <section>
        <h2>Remote access</h2>
        <p>
          Microsoft provisions the HTTPS URL for this installation's tunnel.
          Only sources marked for sharing are exposed; the separate host access
          key is required.
        </p>
        <p className="muted">
          Dev Tunnels is a Microsoft preview service without a production SLA.
          Hosting needs Microsoft&apos;s separately installed CLI. The installer
          checks this when you choose the host role, but does not download or
          install the CLI. Client-only machines do not need it; install it
          before switching to hosting.
        </p>
        <div className="actions">
          <button
            disabled={busy}
            onClick={() => void run(() => window.modelbridge.loginTunnel())}
          >
            Sign in to Microsoft Dev Tunnels
          </button>
          <button
            className="primary"
            disabled={busy || !status}
            onClick={() =>
              void run(() =>
                status?.sharing ?
                  window.modelbridge.stopSharing()
                : window.modelbridge.startSharing(),
              )
            }
          >
            {status?.sharing ? 'Stop sharing' : 'Enable remote access'}
          </button>
          <button
            disabled={!status?.sharing || busy}
            onClick={() => void reveal(true)}
          >
            Show host access key
          </button>
        </div>
        {status?.login && (
          <p>
            Open <code>{status.login.url}</code> in your browser and enter{' '}
            <strong>{status.login.code}</strong>. Refresh occurs automatically
            after sign-in.
          </p>
        )}
        {status?.remoteUrl && (
          <p>
            Host URL: <code>{status.remoteUrl}</code>
          </p>
        )}
      </section>
      {revealed && (
        <section className="key">
          <h2>{revealed.label}</h2>
          <code>{revealed.key}</code>
          <button onClick={() => setRevealed(null)}>Hide key</button>
          <p>
            Share keys securely. Revealed keys clear when the window loses
            focus.
          </p>
        </section>
      )}
    </main>
  )
}
