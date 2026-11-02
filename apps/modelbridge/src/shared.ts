import type { AppStatus, Result } from './types'

export type Run = (
  operation: () => Promise<Result<AppStatus>>,
  // Shows the failure next to the control instead of the page-level alert.
  onError?: (message: string) => void,
) => Promise<boolean>

export function sharedModelIds(status: AppStatus) {
  return new Set(
    status.sources
      .filter((source) => source.shared)
      .flatMap((source) =>
        source.models
          .filter(
            (model) =>
              source.sharedModelIds === undefined
              || source.sharedModelIds.includes(model.id),
          )
          .map((model) => `${source.id}/${model.id}`),
      ),
  )
}
