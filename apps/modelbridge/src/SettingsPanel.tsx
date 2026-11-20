import { useState } from 'react'
import type { Role } from '@modelbridge/runtime/contracts'
import type { AppStatus } from './types'
import { failure, plural } from './format'
import { CopyButton, copyText } from './gateway-client'
import { KeyReveal, type Revealed } from './KeyReveal'
import type { Run } from './shared'

function ClientName({
  status,
  busy,
  run,
}: {
  status: AppStatus
  busy: boolean
  run: Run
}) {
  const [name, setName] = useState(status.clientName)
  const trimmed = name.trim()
  return (
    <section>
      <h2>Client machine name</h2>
      <p className="muted">
        Hosts show this name on their dashboard so they can see each
        machine&apos;s usage. It is not secret and is not used for sign-in.
      </p>
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault()
          void run(() =>
            window.modelbridge.setClientName(
              trimmed && trimmed !== status.defaultClientName ? trimmed : null,
            ),
          )
        }}
      >
        <label>
          Name
          <input
            name="clientName"
            maxLength={64}
            autoComplete="off"
            placeholder={status.defaultClientName}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <button
          disabled={
            busy || (trimmed || status.defaultClientName) === status.clientName
          }
          type="submit"
        >
          Save name
        </button>
      </form>
    </section>
  )
}

function Updates({
  status,
  busy,
  run,
}: Pick<Props, 'status' | 'busy' | 'run'>) {
  const [confirming, setConfirming] = useState(false)
  const update = status.update
  const latest = update.latest
  const checked =
    update.checkedAt ?
      ` Last checked ${new Date(update.checkedAt).toLocaleString()}.`
    : ''
  const message =
    update.phase === 'checking' ? 'Checking GitHub for a newer release…'
    : update.phase === 'downloading' ?
      `Downloading ${latest?.version ?? 'the update'}… ${Math.round((update.progress ?? 0) * 100)}%`
    : update.phase === 'installing' ?
      'Installing the update. ModelBridge will reopen in a moment.'
    : update.phase === 'available' && latest ?
      `Version ${latest.version}${latest.prerelease ? ' (pre-release)' : ''} is available.${checked}`
    : update.phase === 'current' ? `You have the latest version.${checked}`
    : update.phase === 'error' ?
      `${update.error ?? 'The update check failed.'}${checked}`
    : 'ModelBridge checks GitHub for new releases, including pre-releases, shortly after it starts.'
  const working = ['checking', 'downloading', 'installing'].includes(
    update.phase,
  )
  return (
    <section>
      <h2>Updates</h2>
      <p className="muted">
        Installed version {status.version}. Updates keep your install folder,
        data folder, sign-ins and settings.
      </p>
      <p role="status" aria-live="polite">
        {message}
      </p>
      {update.phase === 'available' && update.error && (
        <p role="alert" className="error">
          {update.error}
        </p>
      )}
      {update.phase === 'downloading' && (
        <progress max={1} value={update.progress ?? 0} />
      )}
      <div className="actions">
        {update.phase === 'available' && latest && !confirming && (
          <button
            className="primary"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            Update to {latest.version}
          </button>
        )}
        {confirming && latest && (
          <>
            <span>
              ModelBridge will download {latest.version}, close, install it and
              reopen. Remote sharing stops while it restarts.
            </span>
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                setConfirming(false)
                void run(() => window.modelbridge.installUpdate())
              }}
            >
              Update and restart
            </button>
            <button disabled={busy} onClick={() => setConfirming(false)}>
              Not now
            </button>
          </>
        )}
        {latest && (
          <button
            disabled={busy}
            onClick={() => void window.modelbridge.openRelease()}
          >
            Release notes
          </button>
        )}
        <button
          disabled={busy || working}
          onClick={() => void run(() => window.modelbridge.checkForUpdate())}
        >
          Check for updates
        </button>
      </div>
    </section>
  )
}

function DataFolder({
  status,
  busy,
  run,
}: Pick<Props, 'status' | 'busy' | 'run'>) {
  const [target, setTarget] = useState<string | null>(null)
  const [error, setError] = useState('')
  const data = status.data
  const choose = async () => {
    setError('')
    try {
      const result = await window.modelbridge.chooseDataFolder()
      if (result.ok) setTarget(result.value)
      else setError(result.error)
    } catch (reason) {
      setError(failure(reason, 'Could not choose a folder.'))
    }
  }
  return (
    <section>
      <h2>Data folder</h2>
      <p className="muted">
        Sign-ins, access keys, hosts, usage history and logs. Keys are stored
        unencrypted, so keep this folder private to you.
      </p>
      <code>{data.path}</code>
      {data.movedFrom && (
        <p className="notice" role="status">
          Your data was copied here from <code>{data.movedFrom}</code>. That
          folder is kept; delete it once everything works. If Codex was set up,
          open Apps and apply its update so it uses the new folder.
        </p>
      )}
      <div className="actions">
        <button
          disabled={busy}
          onClick={() => void window.modelbridge.openDataFolder()}
        >
          Open folder
        </button>
        {data.movable && !target && (
          <button disabled={busy} onClick={() => void choose()}>
            Move data folder…
          </button>
        )}
      </div>
      {!data.movable && (
        <p className="muted">
          You can choose this folder when installing. Moving it here works in
          the installed app.
        </p>
      )}
      {target && (
        <div className="notice warn" role="status">
          ModelBridge will close, copy your data to <code>{target}</code> and
          reopen from there. Your current folder is kept. Remote sharing stops
          while it restarts.
          <div className="actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void run(
                  () => window.modelbridge.moveDataFolder(target),
                  setError,
                )
              }
            >
              Move and restart
            </button>
            <button disabled={busy} onClick={() => setTarget(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  )
}

interface Props {
  status: AppStatus
  role: Role
  busy: boolean
  run: Run
  revealed: Revealed | null
  onReveal: (remote: boolean) => void
  onHide: () => void
}

export function SettingsPanel({
  status,
  role,
  busy,
  run,
  revealed,
  onReveal,
  onHide,
}: Props) {
  const [confirming, setConfirming] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [notice, setNotice] = useState('')
  const other: Role = role === 'host' ? 'client' : 'host'
  const clear = async () => {
    setClearing(true)
    try {
      const result = await window.modelbridge.clearUsage()
      setNotice(result.ok ? 'Usage history cleared.' : result.error)
    } catch (error) {
      setNotice(failure(error, 'Could not clear usage history.'))
    } finally {
      setClearing(false)
      setConfirming(false)
    }
  }
  return (
    <>
      <section>
        <h2>Local gateway</h2>
        <p className="muted">
          Coding tools on this machine use this authenticated endpoint. Closing
          the window keeps ModelBridge running in the tray.
        </p>
        <code>{status.localUrl}</code>
        <div className="actions">
          <CopyButton label="Copy URL" copy={copyText(status.localUrl)} />
          <button disabled={busy} onClick={() => onReveal(false)}>
            Show local key
          </button>
          <CopyButton
            label="Copy key"
            copy={() => window.modelbridge.copyKey(false)}
          />
          <span>{plural(status.models.length, 'model')} available</span>
        </div>
        <KeyReveal revealed={revealed} remote={false} onHide={onHide} />
      </section>
      {role === 'client' && (
        <ClientName status={status} busy={busy} run={run} />
      )}
      <section>
        <h2>Role</h2>
        <p className="muted">
          {role === 'host' ?
            'This machine shares its Copilot subscription. Switching to client hides host setup but keeps your sign-ins and sharing running.'
          : 'This machine uses models from another host. Switch to host to share a Copilot subscription signed in on this machine.'
          }
        </p>
        <div className="actions">
          <button
            disabled={busy}
            onClick={() => void run(() => window.modelbridge.setRole(other))}
          >
            {other === 'host' ? 'Use as host' : 'Use as client'}
          </button>
        </div>
      </section>
      <section>
        <h2>Usage history</h2>
        <p className="muted">
          ModelBridge keeps request metadata (model, token counts, timing and
          reported cost, never prompts or responses) on this machine for up to
          about 13 months.
        </p>
        <div className="actions">
          {confirming ?
            <>
              <span>Delete all saved usage history?</span>
              <button
                className="danger"
                disabled={clearing}
                onClick={() => void clear()}
              >
                {clearing ? 'Clearing…' : 'Delete usage history'}
              </button>
              <button disabled={clearing} onClick={() => setConfirming(false)}>
                Keep history
              </button>
            </>
          : <button
              onClick={() => {
                setNotice('')
                setConfirming(true)
              }}
            >
              Clear usage history…
            </button>
          }
        </div>
        {notice && (
          <p className="muted" role="status">
            {notice}
          </p>
        )}
      </section>
      <Updates status={status} busy={busy} run={run} />
      <DataFolder status={status} busy={busy} run={run} />
      <p className="muted footnote">ModelBridge {status.version}</p>
    </>
  )
}
