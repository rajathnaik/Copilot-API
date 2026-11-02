import { z } from 'zod'
import type { MonthlyClientUsage } from './usage-ledger'

const allowance = z.number().nonnegative().max(1_000_000)

// Monthly Copilot premium-request allowances for remote clients. Limits only
// warn on the host dashboard; requests are never blocked.
export const premiumLimitsSchema = z
  .object({
    // Applies to every client without its own entry; null means no limit.
    defaultMonthly: allowance.nullable(),
    // Per-model allowance for each client.
    models: z.record(z.string().min(1).max(512), allowance),
    // Client overrides; null exempts that client from the default.
    clients: z.record(z.string().min(1).max(64), allowance.nullable()),
  })
  .strict()
export type PremiumLimits = z.infer<typeof premiumLimitsSchema>

export const noPremiumLimits: PremiumLimits = {
  defaultMonthly: null,
  models: {},
  clients: {},
}

export type LimitState = 'none' | 'ok' | 'near' | 'over'

export interface ModelLimitStatus {
  model: string
  premium: number
  limit: number | null
  state: LimitState
}

export interface ClientLimitStatus {
  client: string
  requests: number
  premium: number
  lastSeen: number | null
  limit: number | null
  state: LimitState
  models: ModelLimitStatus[]
}

const severity: Record<LimitState, number> = {
  none: 0,
  ok: 1,
  near: 2,
  over: 3,
}

export function limitState(premium: number, limit: number | null): LimitState {
  if (limit === null) return 'none'
  if (premium > limit) return 'over'
  if (limit > 0 && premium >= limit * 0.8) return 'near'
  return 'ok'
}

export function premiumLimitStatus(
  usage: MonthlyClientUsage[],
  limits: PremiumLimits,
): ClientLimitStatus[] {
  const clients = new Map(usage.map((client) => [client.client, client]))
  for (const name of Object.keys(limits.clients))
    if (!clients.has(name))
      clients.set(name, {
        client: name,
        requests: 0,
        premium: 0,
        lastSeen: 0,
        models: {},
      })
  return [...clients.values()]
    .map((client) => {
      const limit =
        Object.hasOwn(limits.clients, client.client) ?
          (limits.clients[client.client] ?? null)
        : limits.defaultMonthly
      const models = [
        ...new Set([
          ...Object.keys(client.models),
          ...Object.keys(limits.models),
        ]),
      ]
        .map((model) => {
          const premium = Math.round((client.models[model] ?? 0) * 100) / 100
          const modelLimit = limits.models[model] ?? null
          return {
            model,
            premium,
            limit: modelLimit,
            state: limitState(premium, modelLimit),
          }
        })
        .filter((model) => model.premium > 0 || model.limit !== null)
        .sort(
          (left, right) =>
            right.premium - left.premium
            || left.model.localeCompare(right.model),
        )
      const state = [
        limitState(client.premium, limit),
        ...models.map((model) => model.state),
      ].reduce((worst, next) =>
        severity[next] > severity[worst] ? next : worst,
      )
      return {
        client: client.client,
        requests: client.requests,
        premium: client.premium,
        lastSeen: client.lastSeen || null,
        limit,
        state,
        models,
      }
    })
    .sort(
      (left, right) =>
        severity[right.state] - severity[left.state]
        || right.premium - left.premium
        || left.client.localeCompare(right.client),
    )
}
