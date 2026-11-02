import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Role } from '@modelbridge/runtime/contracts'
import type { AppStatus, Result } from './types'
import icon from '../assets/icon.svg'
import { CodexPanel } from './CodexPanel'
import { ConnectPanel } from './ConnectPanel'
import { Dashboard } from './Dashboard'
import { failure } from './format'
import { HostSetup } from './HostSetup'
import type { Revealed } from './KeyReveal'
import { ModelsPanel } from './ModelsPanel'
import { SettingsPanel } from './SettingsPanel'

type Tab = 'dashboard' | 'host' | 'connect' | 'sources' | 'codex' | 'settings'

const roleTabs: Record<Role, Array<{ id: Tab; label: string }>> = {
  host: [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'host', label: 'Host setup' },
    { id: 'sources', label: 'Models' },
    { id: 'codex', label: 'Codex' },
    { id: 'settings', label: 'Settings' },
  ],
  client: [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'connect', label: 'Connect' },
    { id: 'sources', label: 'Models' },
    { id: 'codex', label: 'Codex' },
    { id: 'settings', label: 'Settings' },
  ],
}

// Installations from before roles existed infer theirs from what is set up.
function currentRole(status: AppStatus): Role | null {
  if (status.role) return status.role
  if (
    status.sources.some((source) => source.kind === 'copilot' || source.shared)
  )
    return 'host'
  return status.sources.length ? 'client' : null
}

function defaultTab(status: AppStatus, role: Role): Tab {
  if (role === 'host')
    return status.sources.some((source) => source.kind === 'copilot') ?
        'dashboard'
      : 'host'
  return status.sources.length ? 'dashboard' : 'connect'
}

function Welcome({
  busy,
  onChoose,
}: {
  busy: boolean
  onChoose: (role: Role) => void
}) {
  return (
    <>
      <h2 className="welcome-title">How will you use this machine?</h2>
      <div className="cards">
        <section className="card">
          <h2>Share my Copilot subscription</h2>
          <p className="muted">
            This machine has GitHub Copilot. Sign in once, then give other
            machines a URL and access key. Track usage, cost and quota here.
          </p>
          <button
            className="primary"
            disabled={busy}
            onClick={() => onChoose('host')}
          >
            Set up as host
          </button>
        </section>
        <section className="card">
          <h2>Use Copilot from another machine</h2>
          <p className="muted">
            Paste the host&apos;s URL and access key. ModelBridge discovers the
            models and configures Codex for you.
          </p>
          <button
            className="primary"
            disabled={busy}
            onClick={() => onChoose('client')}
          >
            Set up as client
          </button>
        </section>
      </div>
      <p className="muted footnote">You can switch roles later.</p>
    </>
  )
}

export default function App() {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [selected, setSelected] = useState<Tab | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revealed, setRevealed] = useState<Revealed | null>(null)
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({})
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
        .catch((reason: unknown) => {
          if (active)
            setError(failure(reason, 'Could not read runtime status.'))
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
  const run = async (operation: () => Promise<Result<AppStatus>>) => {
    setBusy(true)
    setError('')
    setRevealed(null)
    try {
      const result = await operation()
      if (result.ok) {
        setStatus(result.value)
        return true
      }
      setError(result.error)
    } catch (reason) {
      setError(failure(reason, 'ModelBridge operation failed.'))
    } finally {
      setBusy(false)
    }
    return false
  }
  const reveal = async (remote: boolean) => {
    setError('')
    try {
      const result = await (remote ?
        window.modelbridge.remoteKey()
      : window.modelbridge.localKey())
      if (result.ok) setRevealed({ remote, key: result.value })
      else setError(result.error)
    } catch (reason) {
      setError(failure(reason, 'Could not reveal the key.'))
    }
  }
  const chooseRole = (next: Role) =>
    void run(() => window.modelbridge.setRole(next)).then((ok) => {
      if (ok) setSelected(null)
    })

  const role = status ? currentRole(status) : null
  const tabs = role ? roleTabs[role] : []
  const tab: Tab =
    selected && tabs.some((item) => item.id === selected) ? selected
    : status && role ? defaultTab(status, role)
    : 'dashboard'
  const select = (next: Tab) => {
    setSelected(next)
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
  const panel = (id: Tab) => ({
    id: `panel-${id}`,
    role: 'tabpanel',
    'aria-labelledby': `tab-${id}`,
    hidden: tab !== id,
    tabIndex: 0,
  })
  const keys = {
    revealed,
    onReveal: (remote: boolean) => void reveal(remote),
    onHide: () => setRevealed(null),
  }
  return (
    <main>
      <header>
        <img src={icon} alt="" width="40" height="40" />
        <div>
          <h1>ModelBridge</h1>
          <p>
            {role === 'host' ?
              'Sharing this machine’s Copilot subscription.'
            : role === 'client' ?
              'Using Copilot models from another machine.'
            : 'Share your Copilot subscription, or use one from another host.'}
          </p>
        </div>
        {role && (
          <div className="segmented role" role="group" aria-label="Role">
            {(['host', 'client'] as const).map((item) => (
              <button
                key={item}
                aria-pressed={role === item}
                disabled={busy}
                onClick={() => {
                  if (item !== role) chooseRole(item)
                }}
              >
                {item === 'host' ? 'Host' : 'Client'}
              </button>
            ))}
          </div>
        )}
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
      : !role ?
        <Welcome busy={busy} onChoose={chooseRole} />
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
                onClick={() => setSelected(item.id)}
              >
                {item.label}
                {item.id === 'sources' && status.sources.length > 0 && (
                  <span className="count">{status.models.length}</span>
                )}
                {item.id === 'host' && status.sharing && (
                  <span className="live" aria-label="(sharing)" />
                )}
              </button>
            ))}
          </div>

          <div {...panel('dashboard')}>
            <Dashboard
              role={role}
              active={tab === 'dashboard'}
              onConfigureCodex={() => select('codex')}
            />
          </div>

          {role === 'host' ?
            <div {...panel('host')}>
              <HostSetup
                status={status}
                busy={busy}
                run={run}
                onError={setError}
                onReviewModels={() => select('sources')}
                {...keys}
              />
            </div>
          : <div {...panel('connect')}>
              <ConnectPanel
                status={status}
                busy={busy}
                run={run}
                onAdded={() => select('sources')}
              />
            </div>
          }

          <div {...panel('sources')}>
            <ModelsPanel
              status={status}
              role={role}
              busy={busy}
              run={run}
              onSetUp={() => select(role === 'host' ? 'host' : 'connect')}
            />
          </div>

          <div {...panel('codex')}>
            <CodexPanel models={status.models} />
          </div>

          <div {...panel('settings')}>
            <SettingsPanel
              status={status}
              role={role}
              busy={busy}
              run={run}
              {...keys}
            />
          </div>
        </>
      }
    </main>
  )
}
