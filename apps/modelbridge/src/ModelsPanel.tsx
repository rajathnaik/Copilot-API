import type { Role } from '@modelbridge/runtime/contracts'
import type { AppStatus } from './types'
import { plural } from './format'
import { sharedModelIds, type Run } from './shared'
import { SourceSharing } from './SourceSharing'
import { WebSearchModel } from './WebSearchModel'

const kinds = {
  copilot: 'Copilot subscription',
  remote: 'ModelBridge host',
  api: 'Provider API',
}

export function ModelsPanel({
  status,
  role,
  busy,
  run,
  onSetUp,
}: {
  status: AppStatus
  role: Role
  busy: boolean
  run: Run
  onSetUp: () => void
}) {
  const shared = sharedModelIds(status)
  const host = role === 'host'
  return (
    <>
      <section>
        <h2>Sources</h2>
        <p className="muted">
          {host ?
            "Choose all models or a specific selection for each shared source. Clients can discover and call only the models allowed here, even if they know another model's ID."
          : 'Models discovered from your connected hosts. Refresh a source after the host changes which models it shares.'
          }
        </p>
        {!status.sources.length && (
          <div className="actions">
            <span>No sources yet.</span>
            <button className="primary" onClick={onSetUp}>
              {host ? 'Open host setup' : 'Connect a host'}
            </button>
          </div>
        )}
        {status.sources.map((source) => (
          <div className="source" key={source.id}>
            <strong>{source.label}</strong>
            <span className="muted">
              {kinds[source.kind]} · {plural(source.models.length, 'model')}
            </span>
            <button
              disabled={busy}
              onClick={() =>
                void run(() => window.modelbridge.refreshSource(source.id))
              }
            >
              Refresh models
            </button>
            {host && (
              <>
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
              </>
            )}
            {source.kind === 'copilot' && (
              <WebSearchModel
                source={source}
                busy={busy}
                onChange={(modelId) =>
                  void run(() =>
                    window.modelbridge.setWebSearchModel(source.id, modelId),
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
                  {host && <th>Remote client access</th>}
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
                    {host && (
                      <td>{shared.has(model.id) ? 'Shared' : 'Private'}</td>
                    )}
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
    </>
  )
}
