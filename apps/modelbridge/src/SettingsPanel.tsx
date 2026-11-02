import { useState } from 'react'
import type { Role } from '@modelbridge/runtime/contracts'
import type { AppStatus } from './types'
import { failure, plural } from './format'
import { KeyReveal, type Revealed } from './KeyReveal'
import type { Run } from './shared'

export function SettingsPanel({
  status,
  role,
  busy,
  run,
  revealed,
  onReveal,
  onHide,
}: {
  status: AppStatus
  role: Role
  busy: boolean
  run: Run
  revealed: Revealed | null
  onReveal: (remote: boolean) => void
  onHide: () => void
}) {
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
          <button disabled={busy} onClick={() => onReveal(false)}>
            Show local key
          </button>
          <span>{plural(status.models.length, 'model')} available</span>
        </div>
        <KeyReveal revealed={revealed} remote={false} onHide={onHide} />
      </section>
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
      <p className="muted footnote">ModelBridge {status.version}</p>
    </>
  )
}
