import {
  webSearchCandidates,
  webSearchModel,
  type Source,
} from '@modelbridge/runtime/contracts'

export function WebSearchModel({
  source,
  busy,
  onChange,
}: {
  source: Source
  busy: boolean
  onChange: (modelId: string | null) => void
}) {
  const candidates = webSearchCandidates(source)
  const auto = webSearchModel({ models: source.models })
  const current = webSearchModel(source)
  return (
    <label className="web-search-model">
      Web search model for {source.label}
      <select
        disabled={busy || !candidates.length}
        value={source.webSearchModelId ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">
          Auto{auto ? ` (${auto.name})` : ' (no eligible model)'}
        </option>
        {candidates.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name} ({model.id})
          </option>
        ))}
      </select>
      <span className="muted">
        {current ?
          `Claude and other non-GPT models use ${current.name} to run web searches on this host, even if it is not shared with clients.`
        : 'Web search is unavailable for non-GPT models until a GPT Responses model is discovered.'
        }
      </span>
    </label>
  )
}
