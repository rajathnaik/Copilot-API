import type { AppStatus, Result } from './types'

export type Run = (
  operation: () => Promise<Result<AppStatus>>,
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
