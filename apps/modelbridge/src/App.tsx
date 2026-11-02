import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { SourceInput } from '@modelbridge/runtime/contracts'
import type { AppStatus, Result } from './types'
import icon from '../assets/icon.svg'
import { CodexPanel } from './CodexPanel'
import { SourceSharing } from './SourceSharing'
import { WebSearchModel } from './WebSearchModel'

const initialInput: SourceInput = {
  label: 'Remote Copilot host',
  kind: 'remote',
  baseUrl: '',
  protocol: 'responses',
  apiKey: '',
  shared: false,
}

const tabs = [
  { id: 'overview', label: 'Overview' },
  { id: 'host', label: 'Host' },
  { id: 'connect', label: 'Connect' },
  { id: 'sources', label: 'Sources & models' },
  { id: 'codex', label: 'Codex' },
] as const
type Tab = (typeof tabs)[number]['id']

interface Revealed {
  remote: boolean
  key: string
}

function message(failure: unknown, fallback: string) {
  return failure instanceof Error ? failure.message : fallback
}

function KeyReveal({
  revealed,
  remote,
  onHide,
}: {
  revealed: Revealed | null
  remote: boolean
  onHide: () => void
}) {
  if (revealed?.remote !== remote) return null
  return (
    <div className="key">
      <code>{revealed.key}</code>
      <button onClick={onHide}>Hide key</button>
      <p className="muted">
        Share keys securely. Revealed keys clear when the window loses focus.
      </p>
    </div>
  )
}

export default function App() {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const copilotLogin = status?.copilotLogin
  const [tab, setTab] = useState<Tab>('overview')
  const [input, setInput] = useState(initialInput)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revealed, setRevealed] = useState<Revealed | null>(null)
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  useEffect(() => {
    let active = true
    // The runtime answers only after it has started, so never stack status
    // requests behind a slow startup.
    let pending = false
    const refresh = () => {
      if (pending) return
      pending = true
      void window.modelbridge
        .status()
        .then((result) => {
          if (!active) return
          if (result.ok) setStatus(result.value)
          else setError(result.error)
        })
        .catch((failure: unknown) => {
          if (active)
            setError(message(failure, 'Could not read runtime status.'))
        })
        .finally(() => {
          pending = false
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
        if (clearInput) {
          setInput(initialInput)
          setTab('sources')
        }
      } else setError(result.error)
    } catch (failure) {
      setError(message(failure, 'ModelBridge operation failed.'))
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
      if (result.ok) setRevealed({ remote, key: result.value })
      else setError(result.error)
    } catch (failure) {
      setError(message(failure, 'Could not reveal the key.'))
    }
  }
  const select = (next: Tab) => {
    setTab(next)
    tabRefs.current[next]?.focus()
  }
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((item) => item.id === tab)
    const target =
      event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length]
      : event.key === 'ArrowLeft' ?
        tabs[(index - 1 + tabs.length) % tabs.length]
      : event.key === 'Home' ? tabs[0]
      : event.key === 'End' ? tabs[tabs.length - 1]
      : null
    if (!target) return
    event.preventDefault()
    select(target.id)
  }
  const copilotSources =
    status?.sources.filter((source) => source.kind === 'copilot') ?? []
  const clientSources =
    status?.sources.filter((source) => source.kind !== 'copilot') ?? []
  const sharedModels = new Set(
    status?.sources
      .filter((source) => source.shared)
      .flatMap((source) =>
        source.models
          .filter(
            (model) =>
              source.sharedModelIds === undefined
              || source.sharedModelIds.includes(model.id),
          )
          .map((model) => `${source.id}/${model.id}`),
      ) ?? [],
  )
  const panel = (id: Tab) => ({
    id: `panel-${id}`,
    role: 'tabpanel',
    'aria-labelledby': `tab-${id}`,
    hidden: tab !== id,
    tabIndex: 0,
  })
  return (
    <main>
      <header>
        <img src={icon} alt="" width="40" height="40" />
        <div>
          <h1>ModelBridge</h1>
          <p>Share your Copilot subscription, or use one from another host.</p>
        </div>
        <span className="version">{status?.version ?? ''}</span>
      </header>
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
      {!status ?
        <section className="starting" role="status" aria-live="polite">
          <h2>Starting ModelBridge…</h2>
          <p>Starting the local gateway. This usually takes a few seconds.</p>
        </section>
      : <>
          <div
            className="tabs"
            role="tablist"
            aria-label="ModelBridge sections"
            onKeyDown={onTabKey}
          >
            {tabs.map((item) => (
              <button
                key={item.id}
                id={`tab-${item.id}`}
                ref={(element) => {
                  tabRefs.current[item.id] = element
                }}
                role="tab"
                aria-selected={tab === item.id}
                aria-controls={`panel-${item.id}`}
                tabIndex={tab === item.id ? 0 : -1}
                onClick={() => setTab(item.id)}
              >
                {item.label}
                {item.id === 'sources' && status.sources.length > 0 && (
                  <span className="count">{status.models.length}</span>
                )}
              </button>
            ))}
          </div>

          <div {...panel('overview')}>
            <div className="cards">
              <section className="card">
                <h2>Host this machine</h2>
                <p className="state">
                  {status.sharing ?
                    'Sharing remotely'
                  : copilotSources.length ?
                    'Copilot connected, not shared'
                  : 'Not set up'}
                </p>
                <p className="muted">
                  Sign in to Copilot, then enable remote access to get a URL and
                  key for your other machines.
                </p>
                <button className="primary" onClick={() => select('host')}>
                  Open host setup
                </button>
              </section>
              <section className="card">
                <h2>Use another host</h2>
                <p className="state">
                  {clientSources.length ?
                    `${clientSources.length} source${clientSources.length === 1 ? '' : 's'} connected`
                  : 'No hosts connected'}
                </p>
                <p className="muted">
                  Enter a host URL and access key, then configure Codex with the
                  discovered models.
                </p>
                <div className="actions">
                  <button className="primary" onClick={() => select('connect')}>
                    Connect a host
                  </button>
                  <button onClick={() => select('codex')}>
                    Configure Codex
                  </button>
                </div>
              </section>
            </div>
            <section>
              <h2>Local gateway</h2>
              <p className="muted">
                Coding tools on this machine use this authenticated endpoint.
                Closing the window keeps ModelBridge running in the tray.
              </p>
              <code>{status.localUrl}</code>
              <div className="actions">
                <button disabled={busy} onClick={() => void reveal(false)}>
                  Show local key
                </button>
                <span>
                  {status.models.length} model
                  {status.models.length === 1 ? '' : 's'} available
                </span>
              </div>
              <KeyReveal
                revealed={revealed}
                remote={false}
                onHide={() => setRevealed(null)}
              />
            </section>
          </div>

          <div {...panel('host')}>
            <section>
              <h2>1. Sign in to GitHub Copilot</h2>
              <p className="muted">
                ModelBridge refreshes Copilot tokens, discovers your models and
                forwards requests directly, following the original gateway.
              </p>
              {copilotSources.length > 0 && (
                <p role="status">
                  Signed in to Copilot:{' '}
                  {copilotSources
                    .map(
                      (source) =>
                        `${source.label} (${source.models.length} models)`,
                    )
                    .join(', ')}
                </p>
              )}
              <div className="actions">
                <button
                  className="primary"
                  disabled={busy || !!copilotLogin || copilotSources.length > 0}
                  onClick={() =>
                    void run(() =>
                      window.modelbridge.loginCopilot(
                        'My Copilot subscription',
                        true,
                      ),
                    )
                  }
                >
                  {copilotLogin ?
                    'Waiting for GitHub approval...'
                  : copilotSources.length ?
                    'Signed in'
                  : 'Sign in and discover models'}
                </button>
                {copilotSources.length > 0 && (
                  <button
                    disabled={busy || !!copilotLogin}
                    onClick={() =>
                      void run(() =>
                        window.modelbridge.loginCopilot(
                          'My Copilot subscription',
                          true,
                        ),
                      )
                    }
                  >
                    Sign in again
                  </button>
                )}
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
                <div className="login">
                  <p role="status">
                    Enter <strong>{copilotLogin.code}</strong> at{' '}
                    <code>{copilotLogin.url}</code>. Discovery continues
                    automatically.
                  </p>
                  <button
                    onClick={() =>
                      void window.modelbridge
                        .openLogin(copilotLogin.url)
                        .then((result) => {
                          if (!result.ok) setError(result.error)
                        })
                        .catch((failure: unknown) =>
                          setError(
                            message(failure, 'Could not open GitHub sign-in.'),
                          ),
                        )
                    }
                  >
                    Open GitHub sign-in
                  </button>
                </div>
              )}
            </section>
            <section>
              <h2>2. Enable remote access</h2>
              <p className="muted">
                Microsoft Dev Tunnels provides the HTTPS URL. Sign in to Dev
                Tunnels once on this host, with the GitHub account you use for
                Copilot or a Microsoft account, not both. This authorizes the
                tunnel, separately from access to your Copilot models. Client
                machines never sign in; they only need the URL and the host
                access key. Only sources marked for sharing are exposed. Hosting
                requires the separately installed Dev Tunnels CLI; client-only
                machines do not.
              </p>
              <div className="actions">
                <span>
                  {sharedModels.size} models available to remote clients
                </span>
                <button onClick={() => select('sources')}>
                  Review shared models
                </button>
              </div>
              <p role="status">
                {status.tunnelSigningIn ?
                  'Dev Tunnels: waiting for browser approval...'
                : status.tunnelUserChecking ?
                  'Dev Tunnels: checking sign-in...'
                : status.tunnelAccountError ?
                  'Dev Tunnels: sign-in could not be confirmed.'
                : status.tunnelUser ?
                  <>
                    Dev Tunnels: signed in as{' '}
                    <strong>{status.tunnelUser.name}</strong> using{' '}
                    {status.tunnelUser.provider}.
                  </>
                : 'Dev Tunnels: not signed in.'}
              </p>
              {status.tunnelAccountError && (
                <p role="alert" className="error">
                  {status.tunnelAccountError}
                </p>
              )}
              <div className="actions">
                {status.tunnelSigningIn || status.tunnelUserChecking ?
                  <button disabled>
                    {status.tunnelSigningIn ?
                      'Waiting for approval...'
                    : 'Checking sign-in...'}
                  </button>
                : status.tunnelUser && !status.tunnelAccountError ?
                  <button disabled>Signed in</button>
                : <>
                    <button
                      className="primary"
                      disabled={busy || status.sharing}
                      onClick={() =>
                        void run(() => window.modelbridge.loginTunnel('github'))
                      }
                    >
                      Sign in with GitHub
                    </button>
                    <button
                      disabled={busy || status.sharing}
                      onClick={() =>
                        void run(() =>
                          window.modelbridge.loginTunnel('microsoft'),
                        )
                      }
                    >
                      Sign in with Microsoft
                    </button>
                  </>
                }
                <button
                  disabled={busy || status.tunnelUserChecking}
                  onClick={() =>
                    void run(() => window.modelbridge.checkTunnelLogin())
                  }
                >
                  {status.tunnelSigningIn ?
                    "I've signed in - check status"
                  : 'Check sign-in status'}
                </button>
                <button
                  className={status.tunnelUser ? 'primary' : undefined}
                  disabled={
                    busy
                    || (!status.sharing
                      && (status.tunnelSigningIn
                        || status.tunnelUserChecking
                        || !status.tunnelUser
                        || !!status.tunnelAccountError))
                  }
                  onClick={() =>
                    void run(() =>
                      status.sharing ?
                        window.modelbridge.stopSharing()
                      : window.modelbridge.startSharing(),
                    )
                  }
                >
                  {status.sharing ? 'Stop sharing' : 'Enable remote access'}
                </button>
              </div>
              {status.tunnelUser
                && !status.tunnelSigningIn
                && !status.tunnelUserChecking && (
                  <details>
                    <summary>Change Dev Tunnels account</summary>
                    <p className="muted">
                      Stop sharing before changing accounts. A different account
                      might not own this installation's tunnel.
                    </p>
                    <div className="actions">
                      <button
                        disabled={busy || status.sharing}
                        onClick={() =>
                          void run(() =>
                            window.modelbridge.loginTunnel('github'),
                          )
                        }
                      >
                        Switch to a GitHub account
                      </button>
                      <button
                        disabled={busy || status.sharing}
                        onClick={() =>
                          void run(() =>
                            window.modelbridge.loginTunnel('microsoft'),
                          )
                        }
                      >
                        Switch to a Microsoft account
                      </button>
                    </div>
                  </details>
                )}
              {status.login && (
                <div className="login">
                  <p role="status">
                    Enter <strong>{status.login.code}</strong> at{' '}
                    <code>{status.login.url}</code>. Status refreshes
                    automatically after the CLI confirms sign-in. If it has not
                    updated after browser approval, use "I've signed in - check
                    status"; this verifies the account with the CLI.
                  </p>
                  <button
                    onClick={() => {
                      const url = status.login?.url
                      if (!url) return
                      void window.modelbridge
                        .openLogin(url)
                        .then((result) => {
                          if (!result.ok) setError(result.error)
                        })
                        .catch((failure: unknown) =>
                          setError(
                            message(
                              failure,
                              'Could not open the sign-in page.',
                            ),
                          ),
                        )
                    }}
                  >
                    Open sign-in page
                  </button>
                </div>
              )}
            </section>
            {status.sharing && (
              <section>
                <h2>3. Give these to your client machine</h2>
                <dl className="pairs">
                  <dt>Host URL</dt>
                  <dd>
                    <code>{status.remoteUrl ?? 'Waiting for the tunnel…'}</code>
                  </dd>
                  <dt>Access key</dt>
                  <dd>
                    <button disabled={busy} onClick={() => void reveal(true)}>
                      Show host access key
                    </button>
                  </dd>
                </dl>
                <KeyReveal
                  revealed={revealed}
                  remote
                  onHide={() => setRevealed(null)}
                />
              </section>
            )}
          </div>

          <div {...panel('connect')}>
            <section>
              <h2>Connect a remote host or API</h2>
              <p className="muted">
                For another ModelBridge host, paste its URL and access key.
                Models are discovered automatically.
              </p>
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
                        kind:
                          event.target.value === 'remote' ? 'remote' : 'api',
                      })
                    }
                  >
                    <option value="remote">Remote ModelBridge host</option>
                    <option value="api">Provider API</option>
                  </select>
                </label>
                <label className="wide">
                  {input.kind === 'remote' ?
                    'Host URL'
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
                <div className="actions wide">
                  <button className="primary" disabled={busy} type="submit">
                    {busy ? 'Working…' : 'Discover and add'}
                  </button>
                </div>
              </form>
            </section>
          </div>

          <div {...panel('sources')}>
            <section>
              <h2>Sources</h2>
              <p className="muted">
                Choose all models or a specific selection for each shared
                source. Clients can discover and call only the models allowed
                here, even if they know another model's ID.
              </p>
              {!status.sources.length && (
                <p className="muted">
                  No sources yet. Sign in on the Host tab, or connect a host on
                  the Connect tab.
                </p>
              )}
              {status.sources.map((source) => (
                <div className="source" key={source.id}>
                  <strong>{source.label}</strong>
                  <span className="muted">
                    {source.kind} · {source.models.length} models
                  </span>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        window.modelbridge.refreshSource(source.id),
                      )
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
                  <SourceSharing
                    source={source}
                    busy={busy}
                    onChange={(modelIds) =>
                      void run(() =>
                        window.modelbridge.shareSource(
                          source.id,
                          source.shared,
                          modelIds,
                        ),
                      )
                    }
                  />
                  {source.kind === 'copilot' && (
                    <WebSearchModel
                      source={source}
                      busy={busy}
                      onChange={(modelId) =>
                        void run(() =>
                          window.modelbridge.setWebSearchModel(
                            source.id,
                            modelId,
                          ),
                        )
                      }
                    />
                  )}
                </div>
              ))}
            </section>
            {!!status.models.length && (
              <section>
                <h2>Models</h2>
                <div className="table">
                  <table>
                    <thead>
                      <tr>
                        <th>Model</th>
                        <th>Source</th>
                        <th>Native protocol</th>
                        <th>Remote client access</th>
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
                            {sharedModels.has(model.id) ? 'Shared' : 'Private'}
                          </td>
                          <td>
                            <code>{model.id}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>

          <div {...panel('codex')}>
            <CodexPanel models={status.models} />
          </div>
        </>
      }
    </main>
  )
}
