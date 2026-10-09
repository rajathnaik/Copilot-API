import { Hono } from "hono"

import {
  getTokenUsageDailySummary,
  getTokenUsageEventsPage,
  getTokenUsageSummary,
  type TokenUsagePeriod,
} from "~/lib/token-usage"

export const tokenUsageRoute = new Hono()

const periods = new Set<TokenUsagePeriod>([
  "today",
  "this_week",
  "last_7_days",
  "this_month",
  "last_30_days",
  "lifetime",
])
const DEFAULT_EVENTS_PAGE_SIZE = 20

const legacyPeriods: Record<string, TokenUsagePeriod> = {
  day: "today",
  week: "last_7_days",
  month: "last_30_days",
}

function parsePeriod(value: string | undefined): TokenUsagePeriod {
  if (periods.has(value as TokenUsagePeriod)) {
    return value as TokenUsagePeriod
  }

  return (value ? legacyPeriods[value] : undefined) ?? "today"
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

tokenUsageRoute.get("/", async (c) => {
  const period = parsePeriod(c.req.query("period"))
  const summary = await getTokenUsageSummary(period)
  return c.json(summary)
})

tokenUsageRoute.get("/daily", async (c) => {
  const period = parsePeriod(c.req.query("period"))
  const summary = await getTokenUsageDailySummary(period)
  return c.json(summary)
})

tokenUsageRoute.get("/events", async (c) => {
  const period = parsePeriod(c.req.query("period"))
  const page = parsePositiveInt(c.req.query("page"), 1)
  const pageSize = parsePositiveInt(
    c.req.query("page_size"),
    DEFAULT_EVENTS_PAGE_SIZE,
  )
  const eventsPage = await getTokenUsageEventsPage({ page, pageSize, period })
  return c.json(eventsPage)
})
