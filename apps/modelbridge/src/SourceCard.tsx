import { useEffect, useState, type ReactNode } from 'react'
import type { Source } from '@modelbridge/runtime/contracts'
import type { AppStatus, SourceHealth } from './types'
import { formatDateTime, plural } from './format'
import type { Run } from './shared'

export const sourceKinds = {
  copilot: 'Copilot subscription',
  remote: 'ModelBridge host',
  api: 'Provider API',
}

// Returns the source-qualified model Codex uses through ModelBridge, if any.
export function useCodexModel(status: AppStatus): string | null {
  const [model, setModel] = useState<string | null>(null)
  const models = status.models.map((item) => item.id).join('\n')
  useEffect(() => {
    let active = true
    void window.modelbridge
      .codexStatus()
      .then((result) => {
        if (active && result.ok)
          setModel(
            result.value.effective.provider === 'modelbridge' ?
              result.value.effective.model
            : null,
          )
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [models])
  return model
}

// Two connections to the same ModelBridge host URL list every model twice.
export function isDuplicate(source: Source, sources: Source[]) {
  return (
    source.kind === 'remote'
    && sources.some(
      (other) =>
        other.id !== source.id
        && other.kind === 'remote'
        && other.baseUrl === source.baseUrl,
    )
  )
}

function EditForm({
  source,
  busy,
  run,
  onDone,
}: {
  source: Source
  busy: boolean
  run: Run
  onDone: () => void
}) {
  const [label, setLabel] = useState(source.label)
  const [baseUrl, setBaseUrl] = useState(source.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState('')
  const copilot = source.kind === 'copilot'
  return (
    <form
      className="source-edit"
      onSubmit={(event) => {
        event.preventDefault()
        setError('')
        const key = apiKey.trim()
        void run(
          () =>
            window.modelbridge.updateSource({
              sourceId: source.id,
              label: label.trim(),
              ...(!copilot && { baseUrl: baseUrl.trim() }),
              ...(!copilot && key && { apiKey: key }),
            }),
          setError,
        ).then((ok) => {
          if (ok) onDone()
        })
      }}
    >
      <label>
        Name
        <input
          required
          name="label"
          maxLength={100}
          autoComplete="off"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
      </label>
      {!copilot && (
        <>
          <label>
            {source.kind === 'remote' ? 'Host URL' : 'API base URL'}
            <input
              required
              type="url"
              name="baseUrl"
              autoComplete="off"
              spellCheck={false}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <label className="wide">
            New access key
            <input
              type="password"
              name="apiKey"
              autoComplete="off"
              spellCheck={false}
              placeholder="Leave blank to keep the current key"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <p className="muted wide">
            A new URL or key is checked with the host before it is saved. Codex
            keeps working because the connection keeps its identity.
          </p>
        </>
      )}
      {copilot && (
        <p className="muted wide">
          To renew access, use Sign in again on the Host setup tab.
        </p>
      )}
      {error && (
        <p role="alert" className="error wide">
          {error}
        </p>
      )}
      <div className="actions wide">
        <button className="primary" disabled={busy} type="submit">
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <button type="button" disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function RemoveConfirm({
  source,
  codexModel,
  busy,
  run,
  onDone,
}: {
  source: Source
  codexModel: string | null
  busy: boolean
  run: Run
  onDone: () => void
}) {
  const [error, setError] = useState('')
  return (
    <div className="notice warn source-remove" role="alertdialog">
      <p>
        <strong>Remove {source.label}?</strong> Its{' '}
        {plural(source.models.length, 'model')} will no longer be available on
        this machine.{' '}
        {source.kind === 'copilot' ?
          'ModelBridge forgets this Copilot sign-in, and client machines lose access to its models until you sign in again.'
        : 'Its saved access key is deleted. You can connect it again later with the URL and key.'
        }
      </p>
      {codexModel && (
        <p>
          Codex currently uses{' '}
          <code>{codexModel.split('/').slice(1).join('/')}</code> from this
          source. After removing it, choose another default model on the Codex
          tab.
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="actions">
        <button
          className="danger"
          disabled={busy}
          onClick={() =>
            void run(
              () => window.modelbridge.removeSource(source.id),
              setError,
            ).then((ok) => {
              if (ok) onDone()
            })
          }
        >
          {busy ? 'Removing…' : 'Remove'}
        </button>
        <button disabled={busy} onClick={onDone}>
          Keep it
        </button>
      </div>
    </div>
  )
}

function Health({ health }: { health: SourceHealth | undefined }) {
  if (!health) return null
  return (
    <span className={`badge ${health.ok ? 'ok' : 'over'}`}>
      {health.ok ? 'Connected' : 'Unreachable'}
    </span>
  )
}

export function SourceCard({
  source,
  status,
  codexModel,
  busy,
  run,
  children,
}: {
  source: Source
  status: AppStatus
  codexModel: string | null
  busy: boolean
  run: Run
  children?: ReactNode
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'remove'>('view')
  const health = status.sourceHealth[source.id]
  const usedByCodex =
    codexModel?.startsWith(`${source.id}/`) ? codexModel : null
  const duplicate = isDuplicate(source, status.sources)
  return (
    <article className="source-card" data-source-id={source.id}>
      <div className="source-head">
        <div className="source-title">
          <strong>{source.label}</strong>
          <span className="badge">{sourceKinds[source.kind]}</span>
          <Health health={health} />
          {usedByCodex && <span className="badge info">Used by Codex</span>}
          {duplicate && <span className="badge near">Duplicate</span>}
        </div>
        <div className="source-actions">
          <button
            disabled={busy}
            onClick={() =>
              void run(() => window.modelbridge.refreshSource(source.id))
            }
          >
            {source.kind === 'copilot' ? 'Refresh models' : 'Check connection'}
          </button>
          <button
            disabled={busy}
            aria-expanded={mode === 'edit'}
            onClick={() => setMode(mode === 'edit' ? 'view' : 'edit')}
          >
            Edit
          </button>
          <button
            disabled={busy}
            aria-expanded={mode === 'remove'}
            onClick={() => setMode(mode === 'remove' ? 'view' : 'remove')}
          >
            Remove…
          </button>
        </div>
      </div>
      <p className="source-meta muted">
        {source.kind !== 'copilot' && <code>{source.baseUrl}</code>}
        {source.account && <span>GitHub account {source.account}</span>}
        <span>{plural(source.models.length, 'model')}</span>
        {health && (
          <span>Checked {formatDateTime(Date.parse(health.checkedAt))}</span>
        )}
      </p>
      {health && !health.ok && health.message && (
        <p role="alert" className="error">
          {health.message}
        </p>
      )}
      {duplicate && (
        <p className="notice warn">
          Another connection uses this host URL, so its models are listed twice
          in Codex. Keep one and remove the other
          {usedByCodex ? '. Codex uses this one' : ''}.
        </p>
      )}
      {mode === 'edit' && (
        <EditForm
          source={source}
          busy={busy}
          run={run}
          onDone={() => setMode('view')}
        />
      )}
      {mode === 'remove' && (
        <RemoveConfirm
          source={source}
          codexModel={usedByCodex}
          busy={busy}
          run={run}
          onDone={() => setMode('view')}
        />
      )}
      {children}
    </article>
  )
}
