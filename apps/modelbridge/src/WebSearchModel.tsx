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
      Web search helper for Claude and other non-GPT models ({source.label})
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
          `This is not a default model. When Claude or another non-GPT model asks for a web search, ModelBridge runs the search with ${current.name} and hands the results back. It is used even if it is not shared with clients.`
        : 'Web search is unavailable for non-GPT models until a GPT Responses model is discovered.'
        }
      </span>
    </label>
  )
}
