import type { AvailableModel } from '../contracts'
import { codexInstructionsTemplate } from './codex-instructions'

export const codexCatalogMaxBytes = 1024 * 1024
const compactInstructions =
  'Help the user with software engineering tasks. Inspect relevant context before editing, preserve existing behavior, and verify your work. Follow the active sandbox and approval policy. Only use tools provided by the client.'

export function codexDefaultReasoning(model: AvailableModel) {
  return model.reasoningEfforts?.includes('medium') ?
      'medium'
    : (model.reasoningEfforts?.[0] ?? 'none')
}

function codexModel(
  model: AvailableModel,
  priority: number,
  instructions: string,
) {
  const reasoning = (model.reasoningEfforts ?? []).some(
    (effort) => effort !== 'none',
  )
  const contextWindow = model.contextWindow ?? 10_000
  return {
    slug: model.id,
    display_name: `${model.name} / ${model.sourceLabel}`,
    description: `ModelBridge source: ${model.sourceLabel}. No fallback provider.`,
    model_messages: {
      instructions_template: instructions,
      instructions_variables: null,
    },
    input_modalities: model.inputModalities ?? ['text'],
    supports_image_detail_original: false,
    supports_reasoning_summary_parameter: reasoning,
    supports_reasoning_summaries: reasoning,
    default_reasoning_summary: reasoning ? 'auto' : 'none',
    reasoning_summary_format: 'experimental' as const,
    default_reasoning_level: codexDefaultReasoning(model),
    supported_reasoning_levels: (model.reasoningEfforts ?? []).map(
      (effort) => ({
        effort,
        description: `Reasoning effort advertised by ${model.sourceLabel}: ${effort}`,
      }),
    ),
    shell_type:
      model.supportsTools ? ('unified_exec' as const) : ('disabled' as const),
    apply_patch_tool_type: model.supportsTools ? 'freeform' : null,
    web_search_tool_type: 'text' as const,
    supports_search_tool: false,
    supports_parallel_tool_calls:
      model.supportsTools === true && model.supportsParallelToolCalls !== false,
    visibility: 'list' as const,
    supported_in_api: true,
    priority,
    support_verbosity: false,
    context_window: contextWindow,
    max_context_window: contextWindow,
    ...(model.maxOutputTokens && { max_output_tokens: model.maxOutputTokens }),
    effective_context_window_percent: 95,
    // Codex applies this limit to tool output, not to the model context.
    truncation_policy: { mode: 'tokens' as const, limit: 10_000 },
    experimental_supported_tools: [],
  }
}

// Prefer Codex-native instructions, but never drop models to fit the 1 MiB
// client limit; fall back to compact instructions for the whole catalog.
export function createCodexCatalog(models: AvailableModel[]) {
  const eligible = models.filter((model) => model.protocol === 'responses')
  const build = (instructions: string) => ({
    models: eligible.map((model, priority) =>
      codexModel(model, priority, instructions),
    ),
  })
  const native = build(codexInstructionsTemplate)
  return Buffer.byteLength(JSON.stringify(native)) <= codexCatalogMaxBytes ?
      native
    : build(compactInstructions)
}
