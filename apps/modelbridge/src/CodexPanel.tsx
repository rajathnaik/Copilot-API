import { useEffect, useState } from 'react'
import type { AvailableModel } from '@modelbridge/runtime/contracts'
import type {
  CodexConfigurationStatus,
  CodexPreview,
} from '@modelbridge/runtime/codex'
import type { CodexInstallation } from '../electron/codex-discovery'
import type { Result } from './types'

export function CodexPanel({ models }: { models: AvailableModel[] }) {
  const [status, setStatus] = useState<CodexConfigurationStatus | null>(null)
  const [installations, setInstallations] = useState<CodexInstallation[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [label, setLabel] = useState('Remote Copilot')
  const [preview, setPreview] = useState<CodexPreview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const responses = models.filter((item) => item.protocol === 'responses')
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
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Codex operation failed.',
      )
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    void window.modelbridge
      .codexStatus()
      .then((result) => {
        if (result.ok) setStatus(result.value)
        else setError(result.error)
      })
      .catch((failure: unknown) =>
        setError(
          failure instanceof Error ?
            failure.message
          : 'Could not inspect Codex settings.',
        ),
      )
  }, [])
  const selected =
    responses.some((item) => item.id === model) ? model : (
      (responses[0]?.id ?? '')
    )
  return (
    <section>
      <h2>Client: configure Codex</h2>
      <p>
        Codex uses your local ModelBridge gateway. This does not add models to
        your ChatGPT subscription or alter its sign-in. ModelBridge routes each
        request to the source you selected.
      </p>
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
      <div className="actions">
        <button
          disabled={busy}
          onClick={() =>
            void run(
              () => window.modelbridge.discoverCodex(),
              (found) => {
                setInstallations(found.installations)
                setWarnings(found.warnings)
                if (!found.installations.length)
                  setError(
                    'Codex was not discovered. Install Codex or select its console executable.',
                  )
              },
            )
          }
        >
          Discover installed Codex
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void run(
              () => window.modelbridge.selectCodex(),
              (found) => setInstallations([found]),
            )
          }
        >
          Select Codex executable
        </button>
        <button
          disabled={busy}
          onClick={() =>
            void run(() => window.modelbridge.codexStatus(), setStatus)
          }
        >
          Inspect current settings
        </button>
      </div>
      {installations.map((item) => (
        <p key={item.executable}>
          <strong>Codex {item.version}</strong> ({item.kind}){' '}
          <code>{item.executable}</code>
        </p>
      ))}
      {warnings.map((warning) => (
        <p role="alert" key={warning}>
          {warning}
        </p>
      ))}
      <p>
        Configuration file: <code>{status?.configPath ?? 'Inspecting...'}</code>
      </p>
      <p>
        Current user-level provider:{' '}
        <strong>{status?.effective.provider}</strong>. Model:{' '}
        <strong>{status?.effective.model}</strong>. Project, profile, CLI, or
        managed policy overrides can take precedence.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void run(
            () => window.modelbridge.previewCodex(label, selected),
            setPreview,
          )
        }}
      >
        <label>
          Configuration name
          <input
            required
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={100}
          />
        </label>
        <label>
          Default model
          <select
            required
            value={selected}
            onChange={(event) => setModel(event.target.value)}
          >
            {!responses.length && (
              <option value="">
                Add a Copilot source or remote host first
              </option>
            )}
            {responses.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} / {item.sourceLabel}
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary"
          disabled={busy || !installations.length || !selected}
        >
          Preview exact Codex changes
        </button>
      </form>
      {models.some((item) => item.protocol !== 'responses') && (
        <p className="muted">
          Models without a Responses endpoint or a supported inherited adapter
          are not offered to Codex. They remain visible in the source inventory;
          no unsupported model is silently substituted.
        </p>
      )}
      {status?.externalManagedEdit && (
        <div className="notice">
          Codex's provider/model settings changed outside ModelBridge. Applying
          is blocked until you review them.
          <button
            disabled={busy}
            onClick={() =>
              void run(
                () => window.modelbridge.reconcileCodex(),
                (value) => {
                  setStatus(value)
                  setPreview(null)
                },
              )
            }
          >
            Acknowledge current external settings
          </button>
        </div>
      )}
      <div className="actions">
        <button
          disabled={busy || !status?.revisions.length}
          onClick={() =>
            void run(() => window.modelbridge.previewCodexRestore(), setPreview)
          }
        >
          Preview restoration of original settings
        </button>
      </div>
      {!!status?.revisions.length && (
        <details>
          <summary>
            Saved configurations and revisions ({status.revisions.length})
          </summary>
          {status.revisions
            .slice()
            .reverse()
            .map((revision) => (
              <div className="source" key={revision.id}>
                <span>
                  <strong>{revision.label}</strong> {revision.createdAt}{' '}
                  {status.active === revision.id ? '(active)' : ''}
                  <br />
                  <code>{revision.model}</code>
                </span>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () =>
                        window.modelbridge.previewCodexRevision(revision.id),
                      setPreview,
                    )
                  }
                >
                  Preview this configuration
                </button>
              </div>
            ))}
        </details>
      )}
      {preview && (
        <div className="preview">
          <h3>{preview.label}: review before applying</h3>
          <ul>
            {preview.changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
          <p>
            Catalog snapshot: <code>{preview.catalogPath}</code>
          </p>
          <div className="config-diff">
            <div>
              <h4>Current configuration (secrets redacted)</h4>
              <pre>{preview.before || '(No user configuration)'}</pre>
            </div>
            <div>
              <h4>Proposed configuration (secrets redacted)</h4>
              <pre>{preview.after}</pre>
            </div>
          </div>
          <div className="actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void run(
                  () => window.modelbridge.applyCodex(preview.id),
                  (value) => {
                    setStatus(value)
                    setPreview(null)
                  },
                )
              }
            >
              Apply reviewed changes and save revision
            </button>
            <button disabled={busy} onClick={() => setPreview(null)}>
              Cancel preview
            </button>
          </div>
          <p>
            Close and reopen Codex, then start a new local chat. Existing
            threads may retain their old provider. No account file or
            conversation is deleted.
          </p>
        </div>
      )}
    </section>
  )
}
