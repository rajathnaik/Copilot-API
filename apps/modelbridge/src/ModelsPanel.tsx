import type { Role } from '@modelbridge/runtime/contracts'
import type { AppStatus } from './types'
import { plural } from './format'
import { sharedModelIds, type Run } from './shared'
import { SourceCard, useCodexModel } from './SourceCard'
import { SourceSharing } from './SourceSharing'
import { WebSearchModel } from './WebSearchModel'

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
  const codexModel = useCodexModel(status)
  return (
    <>
      <section>
        <h2>Sources</h2>
        <p className="muted">
          {host ?
            "Choose all models or a specific selection for each shared source. Clients can discover and call only the models allowed here, even if they know another model's ID."
          : `Models discovered from ${plural(status.sources.length, 'connected source')}. Check, edit or remove hosts on the Hosts tab.`
          }
        </p>
        {!status.sources.length ?
          <div className="actions">
            <span>No sources yet.</span>
            <button className="primary" onClick={onSetUp}>
              {host ? 'Open host setup' : 'Connect a host'}
            </button>
          </div>
        : !host ?
          <div className="actions">
            <button onClick={onSetUp}>Manage hosts</button>
          </div>
        : <div className="source-cards">
            {status.sources.map((source) => (
              <SourceCard
                key={source.id}
                source={source}
                status={status}
                codexModel={codexModel}
                busy={busy}
                run={run}
              >
                <div className="source">
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
              </SourceCard>
            ))}
          </div>
        }
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
