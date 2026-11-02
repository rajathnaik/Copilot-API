import { useState } from 'react'
import type { Source } from '@modelbridge/runtime/contracts'

export function SourceSharing({
  source,
  busy,
  open = false,
  onChange,
}: {
  source: Source
  busy: boolean
  open?: boolean
  onChange: (modelIds: string[] | null) => void
}) {
  const [filter, setFilter] = useState('')
  const selected = source.models
    .filter(
      (model) =>
        source.sharedModelIds === undefined
        || source.sharedModelIds.includes(model.id),
    )
    .map((model) => model.id)
  const visible = source.models.filter((model) =>
    `${model.name} ${model.id}`.toLowerCase().includes(filter.toLowerCase()),
  )
  return (
    <details className="model-sharing" open={open}>
      <summary>
        Model access: {source.shared ? selected.length : 0} of{' '}
        {source.models.length} shared
      </summary>
      <label>
        Models shared by {source.label}
        <select
          disabled={busy}
          value={source.sharedModelIds === undefined ? 'all' : 'selected'}
          onChange={(event) =>
            onChange(event.target.value === 'all' ? null : selected)
          }
        >
          <option value="all">
            All models, including newly discovered models
          </option>
          <option value="selected">Only selected models</option>
        </select>
      </label>
      <p className="muted">
        This policy applies to every client using the host key. Local tools keep
        access to all models. Changes apply to new requests immediately.
        {!source.shared
          && ' Remote sharing for this source is paused; the selection is still saved.'}
      </p>
      {source.sharedModelIds !== undefined && (
        <>
          <p className="muted">
            Newly discovered models stay private until selected. An empty
            selection shares no models from this source.
          </p>
          <div className="actions">
            <button
              disabled={busy}
              onClick={() => onChange(source.models.map((model) => model.id))}
            >
              Select all models
            </button>
            <button disabled={busy} onClick={() => onChange([])}>
              Clear selection
            </button>
            <span>{selected.length} selected</span>
          </div>
          <label>
            Filter models for {source.label}
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <div className="model-sharing-list">
            {visible.map((model) => (
              <label className="checkbox" key={model.id}>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={selected.includes(model.id)}
                  onChange={(event) =>
                    onChange(
                      source.models
                        .filter((candidate) =>
                          candidate.id === model.id ?
                            event.target.checked
                          : selected.includes(candidate.id),
                        )
                        .map((candidate) => candidate.id),
                    )
                  }
                />
                <span>
                  {model.name} <code>{model.id}</code>
                </span>
              </label>
            ))}
            {!visible.length && (
              <p role="status">No models match this filter.</p>
            )}
          </div>
        </>
      )}
    </details>
  )
}
