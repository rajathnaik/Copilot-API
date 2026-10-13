import type { AvailableModel } from '../contracts'
export function codexDefaultReasoning(model: AvailableModel) {
  return model.reasoningEfforts?.includes('medium') ?
      'medium'
    : (model.reasoningEfforts?.[0] ?? 'none')
}

export function createCodexCatalog(models: AvailableModel[]) {
  return {
    models: models
      .filter((model) => model.protocol === 'responses')
      .map((model, priority) => ({
        slug: model.id,
        display_name: `${model.name} / ${model.sourceLabel}`,
        description: `ModelBridge source: ${model.sourceLabel}. No fallback provider.`,
        model_messages: {
          instructions_template:
            'Help the user with software engineering tasks. Inspect relevant context before editing, preserve existing behavior, and verify your work. Follow the active sandbox and approval policy. Only use tools provided by the client.',
        },
        input_modalities: ['text'],
        supports_reasoning_summary_parameter: false,
        default_reasoning_level: codexDefaultReasoning(model),
        supported_reasoning_levels: (model.reasoningEfforts ?? []).map(
          (effort) => ({
            effort,
            description: `Reasoning effort advertised by ${model.sourceLabel}: ${effort}`,
          }),
        ),
        shell_type:
          model.supportsTools ?
            ('unified_exec' as const)
          : ('disabled' as const),
        visibility: 'list' as const,
        supported_in_api: true,
        priority,
        support_verbosity: false,
        context_window: model.contextWindow ?? 10_000,
        truncation_policy: {
          mode: 'tokens' as const,
          limit: model.contextWindow ?? 10_000,
        },
        experimental_supported_tools: [],
      })),
  }
}
