import { AsyncLocalStorage } from 'node:async_hooks'

export const compactTextOnlyGuard =
  'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.'
export const requestContext = new AsyncLocalStorage<{
  sessionAffinity?: string
  parentSessionId?: string
  startTime?: number
  traceId?: string
  userAgent?: string
}>()
export interface CopilotQuotaSnapshot {
  entitlement: string
  percent_remaining: number
  overage_permitted: boolean
  overage_count: number
  reset_date: string
}
export type ToolContentSupportType = 'array' | 'image' | 'pdf'
export function parseUserIdMetadata(userId: string | undefined) {
  if (!userId) return { safetyIdentifier: null, sessionId: null }
  const legacySafetyIdentifier =
    userId.match(/user_([^_]+)_account/u)?.[1] ?? null
  const legacySessionId = userId.match(/_session_(.+)$/u)?.[1] ?? null
  let parsed: Record<string, unknown> | null = null
  if (!legacySafetyIdentifier || !legacySessionId) {
    try {
      const value: unknown = JSON.parse(userId)
      if (value && typeof value === 'object' && !Array.isArray(value))
        parsed = Object.fromEntries(Object.entries(value))
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
    }
  }
  const field = (name: string) =>
    typeof parsed?.[name] === 'string' && parsed[name].length > 0 ?
      parsed[name]
    : null
  return {
    safetyIdentifier:
      legacySafetyIdentifier ?? field('device_id') ?? field('account_uuid'),
    sessionId: legacySessionId ?? field('session_id'),
  }
}
