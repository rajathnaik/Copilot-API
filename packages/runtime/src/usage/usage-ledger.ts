import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

export const usageRanges = ['today', '7d', '30d', '90d'] as const
export type UsageRange = (typeof usageRanges)[number]

const days: Record<UsageRange, number> = {
  today: 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
}
const dayMs = 24 * 60 * 60 * 1000
// Copilot reports cost in nano AI units; the original gateway billed
// 100 AI units per US dollar.
export const nanoAiuPerUsd = 100_000_000_000
const tokens = z.number().int().nonnegative()

export const usageRecordSchema = z
  .object({
    at: z.number().int().nonnegative(),
    sourceId: z.string().min(1).max(100),
    source: z.string().max(200),
    kind: z.enum(['copilot', 'api', 'remote']),
    model: z.string().min(1).max(512),
    access: z.enum(['local', 'remote']),
    purpose: z.enum(['request', 'continuation', 'web-search']),
    status: z.number().int().min(0).max(999),
    outcome: z.enum(['completed', 'failed', 'cancelled']),
    durationMs: tokens,
    inputTokens: tokens,
    cachedInputTokens: tokens,
    cacheWriteTokens: tokens,
    outputTokens: tokens,
    reasoningTokens: tokens,
    nanoAiu: tokens.nullable(),
    // Added in dev.7; older records omit them.
    initiator: z.enum(['user', 'agent']).nullable().optional(),
    premium: z.number().nonnegative().max(10_000).nullable().optional(),
    client: z.string().min(1).max(64).optional(),
  })
  .strict()
export type UsageRecord = z.infer<typeof usageRecordSchema>
export type UsageEntry = Omit<UsageRecord, 'at'>

export interface UsageTotals {
  requests: number
  // Requests a person started, and requests the agent sent on its own
  // after tool output. Older records without an initiator count in neither.
  prompts: number
  followUps: number
  failed: number
  cancelled: number
  webSearches: number
  unreported: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  premiumRequests: number
  costedRequests: number
  costUsd: number | null
  averageDurationMs: number | null
}

export interface UsageSeries {
  name: string
  tokens: number[]
  requests: number[]
  premium: number[]
}

export interface UsageSummary {
  range: UsageRange
  from: number
  to: number
  totals: UsageTotals
  models: Array<
    UsageTotals & {
      model: string
      source: string
      kind: UsageRecord['kind']
    }
  >
  access: Record<UsageRecord['access'], UsageTotals>
  // Remote access grouped by the name each client machine reports.
  clients: Array<UsageTotals & { client: string; lastSeen: number }>
  daily: Array<{ date: string } & UsageTotals>
  // Daily values aligned with `daily`, per model and per remote client.
  series: { models: UsageSeries[]; clients: UsageSeries[] }
  recent: UsageRecord[]
}

export interface MonthlyClientUsage {
  client: string
  requests: number
  premium: number
  lastSeen: number
  models: Record<string, number>
}

export const unnamedClientLabel = 'Unnamed client'

const filePattern = /^usage-(\d{4})-(\d{2})\.jsonl$/u

function monthFile(at: number) {
  const date = new Date(at)
  return `usage-${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}.jsonl`
}

function localDay(at: number) {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function rankSeries(lines: Map<string, UsageSeries>): UsageSeries[] {
  const total = (line: UsageSeries) =>
    line.tokens.reduce((sum, value) => sum + value, 0)
  return [...lines.values()]
    .map((line) => ({
      ...line,
      premium: line.premium.map((value) => Math.round(value * 100) / 100),
    }))
    .sort(
      (left, right) =>
        total(right) - total(left) || left.name.localeCompare(right.name),
    )
}

class Totals {
  private requests = 0
  private prompts = 0
  private followUps = 0
  private failed = 0
  private cancelled = 0
  private webSearches = 0
  private unreported = 0
  private inputTokens = 0
  private cachedInputTokens = 0
  private cacheWriteTokens = 0
  private outputTokens = 0
  private reasoningTokens = 0
  private premium = 0
  private costedRequests = 0
  private nanoAiu = 0
  private timed = 0
  private duration = 0

  add(record: UsageRecord) {
    this.requests++
    if (record.purpose === 'request' && record.initiator === 'user')
      this.prompts++
    if (record.purpose === 'request' && record.initiator === 'agent')
      this.followUps++
    this.premium += record.premium ?? 0
    if (record.outcome === 'failed') this.failed++
    if (record.outcome === 'cancelled') this.cancelled++
    if (record.purpose === 'web-search') this.webSearches++
    if (
      record.outcome === 'completed'
      && record.inputTokens + record.outputTokens === 0
    )
      this.unreported++
    this.inputTokens += record.inputTokens
    this.cachedInputTokens += record.cachedInputTokens
    this.cacheWriteTokens += record.cacheWriteTokens
    this.outputTokens += record.outputTokens
    this.reasoningTokens += record.reasoningTokens
    if (record.nanoAiu !== null) {
      this.costedRequests++
      this.nanoAiu += record.nanoAiu
    }
    if (record.outcome === 'completed') {
      this.timed++
      this.duration += record.durationMs
    }
    return this
  }

  value(): UsageTotals {
    return {
      requests: this.requests,
      prompts: this.prompts,
      followUps: this.followUps,
      failed: this.failed,
      cancelled: this.cancelled,
      webSearches: this.webSearches,
      unreported: this.unreported,
      inputTokens: this.inputTokens,
      cachedInputTokens: this.cachedInputTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      outputTokens: this.outputTokens,
      reasoningTokens: this.reasoningTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      premiumRequests: Math.round(this.premium * 100) / 100,
      costedRequests: this.costedRequests,
      costUsd: this.costedRequests ? this.nanoAiu / nanoAiuPerUsd : null,
      averageDurationMs:
        this.timed ? Math.round(this.duration / this.timed) : null,
    }
  }
}

/**
 * Persists one record per upstream request as monthly JSON Lines files in the
 * profile and keeps the last 90 days in memory for the dashboard.
 */
export class UsageLedger {
  private records: UsageRecord[] = []
  private writing: Promise<void> = Promise.resolve()
  lastError: string | null = null

  private constructor(
    private readonly directory: string,
    private readonly now: () => number,
  ) {}

  static async open(
    directory: string,
    now: () => number = Date.now,
  ): Promise<UsageLedger> {
    await fs.mkdir(directory, { recursive: true })
    const ledger = new UsageLedger(directory, now)
    const cutoff = ledger.cutoff()
    const removeBefore = now() - 400 * dayMs
    for (const name of (await fs.readdir(directory)).sort()) {
      const month = filePattern.exec(name)
      if (!month) continue
      const end = Date.UTC(Number(month[1]), Number(month[2]), 1)
      if (end < removeBefore) {
        await fs.rm(path.join(directory, name), { force: true })
        continue
      }
      if (end < cutoff) continue
      const text = await fs.readFile(path.join(directory, name), 'utf8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const parsed = usageRecordSchema.safeParse(JSON.parse(line))
          if (parsed.success && parsed.data.at >= cutoff)
            ledger.records.push(parsed.data)
        } catch {
          // A torn final line from an interrupted write is skipped.
        }
      }
    }
    ledger.records.sort((left, right) => left.at - right.at)
    return ledger
  }

  record(entry: UsageEntry): void {
    const parsed = usageRecordSchema.safeParse({ ...entry, at: this.now() })
    if (!parsed.success) {
      this.lastError = 'A usage record was invalid and was not saved.'
      return
    }
    this.records.push(parsed.data)
    const cutoff = this.cutoff()
    if (this.records[0] && this.records[0].at < cutoff)
      this.records = this.records.filter((record) => record.at >= cutoff)
    const file = path.join(this.directory, monthFile(parsed.data.at))
    this.writing = this.writing
      .then(() => fs.appendFile(file, `${JSON.stringify(parsed.data)}\n`))
      .then(() => {
        this.lastError = null
      })
      .catch((error: unknown) => {
        this.lastError = `Usage history could not be saved (${error instanceof Error ? error.name : 'Unknown failure'}).`
      })
  }

  flush(): Promise<void> {
    return this.writing
  }

  async clear(): Promise<void> {
    this.records = []
    await this.writing
    for (const name of await fs.readdir(this.directory))
      if (filePattern.test(name))
        await fs.rm(path.join(this.directory, name), { force: true })
  }

  summary(range: UsageRange): UsageSummary {
    const to = this.now()
    const start = new Date(to)
    start.setHours(0, 0, 0, 0)
    start.setDate(start.getDate() - (days[range] - 1))
    const from = start.getTime()
    const selected = this.records.filter(
      (record) => record.at >= from && record.at <= to,
    )
    const totals = new Totals()
    const models = new Map<
      string,
      {
        model: string
        source: string
        kind: UsageRecord['kind']
        totals: Totals
      }
    >()
    const access = { local: new Totals(), remote: new Totals() }
    const clients = new Map<string, { totals: Totals; lastSeen: number }>()
    const dayIndex = new Map<string, number>()
    const daily = new Map<string, Totals>()
    for (
      const day = new Date(from);
      day.getTime() <= to;
      day.setDate(day.getDate() + 1)
    ) {
      dayIndex.set(localDay(day.getTime()), dayIndex.size)
      daily.set(localDay(day.getTime()), new Totals())
    }
    const series = {
      models: new Map<string, UsageSeries>(),
      clients: new Map<string, UsageSeries>(),
    }
    const plot = (
      target: Map<string, UsageSeries>,
      name: string,
      record: UsageRecord,
    ) => {
      const index = dayIndex.get(localDay(record.at))
      if (index === undefined) return
      let line = target.get(name)
      if (!line) {
        const zeros = () => Array.from({ length: dayIndex.size }, () => 0)
        line = { name, tokens: zeros(), requests: zeros(), premium: zeros() }
        target.set(name, line)
      }
      line.tokens[index] += record.inputTokens + record.outputTokens
      line.requests[index]++
      line.premium[index] += record.premium ?? 0
    }
    for (const record of selected) {
      totals.add(record)
      access[record.access].add(record)
      daily.get(localDay(record.at))?.add(record)
      plot(series.models, record.model, record)
      if (record.access === 'remote') {
        const name = record.client ?? unnamedClientLabel
        const client = clients.get(name) ?? {
          totals: new Totals(),
          lastSeen: 0,
        }
        client.totals.add(record)
        client.lastSeen = Math.max(client.lastSeen, record.at)
        clients.set(name, client)
        plot(series.clients, name, record)
      }
      const key = `${record.sourceId}\u0000${record.model}`
      const group = models.get(key) ?? {
        model: record.model,
        source: record.source,
        kind: record.kind,
        totals: new Totals(),
      }
      group.source = record.source
      group.totals.add(record)
      models.set(key, group)
    }
    return {
      range,
      from,
      to,
      totals: totals.value(),
      models: [...models.values()]
        .map((group) => ({
          model: group.model,
          source: group.source,
          kind: group.kind,
          ...group.totals.value(),
        }))
        .sort(
          (left, right) =>
            right.totalTokens - left.totalTokens
            || right.requests - left.requests
            || left.model.localeCompare(right.model),
        ),
      access: { local: access.local.value(), remote: access.remote.value() },
      clients: [...clients]
        .map(([client, value]) => ({
          client,
          lastSeen: value.lastSeen,
          ...value.totals.value(),
        }))
        .sort(
          (left, right) =>
            right.premiumRequests - left.premiumRequests
            || right.requests - left.requests
            || left.client.localeCompare(right.client),
        ),
      daily: [...daily].map(([date, value]) => ({ date, ...value.value() })),
      series: {
        models: rankSeries(series.models),
        clients: rankSeries(series.clients),
      },
      recent: selected.slice(-25).reverse(),
    }
  }

  // Premium requests each remote client used in the current calendar month,
  // for the host's warn-only limits.
  month(): MonthlyClientUsage[] {
    const start = new Date(this.now())
    start.setHours(0, 0, 0, 0)
    start.setDate(1)
    const clients = new Map<string, MonthlyClientUsage>()
    for (const record of this.records) {
      if (record.access !== 'remote' || record.at < start.getTime()) continue
      const name = record.client ?? unnamedClientLabel
      const client = clients.get(name) ?? {
        client: name,
        requests: 0,
        premium: 0,
        lastSeen: 0,
        models: {},
      }
      const premium = record.premium ?? 0
      client.requests++
      client.premium += premium
      client.lastSeen = Math.max(client.lastSeen, record.at)
      client.models[record.model] = (client.models[record.model] ?? 0) + premium
      clients.set(name, client)
    }
    return [...clients.values()].map((client) => ({
      ...client,
      premium: Math.round(client.premium * 100) / 100,
    }))
  }

  private cutoff() {
    return this.now() - 92 * dayMs
  }
}
