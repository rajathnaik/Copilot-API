export function failure(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

const integer = new Intl.NumberFormat(undefined)
const compact = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
})
const percent = new Intl.NumberFormat(undefined, {
  style: 'percent',
  maximumFractionDigits: 0,
})
const time = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
})
const dateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})
const day = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
})

export const formatInteger = (value: number) => integer.format(value)
export const formatTokens = (value: number) =>
  value < 10_000 ? integer.format(value) : compact.format(value)
export const formatPercent = (value: number) => percent.format(value)
export const formatTime = (at: number) => time.format(at)
export const formatDateTime = (at: number) => dateTime.format(at)

// Daily buckets use local calendar dates (YYYY-MM-DD).
export function formatDay(date: string) {
  const [year, month, dayOfMonth] = date.split('-').map(Number)
  return day.format(new Date(year ?? 0, (month ?? 1) - 1, dayOfMonth ?? 1))
}

export function formatUsd(value: number) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value > 0 && value < 1 ? 4 : 2,
    maximumFractionDigits: value > 0 && value < 1 ? 4 : 2,
  }).format(value)
}

export function formatDuration(ms: number | null) {
  if (ms === null) return '—'
  return ms < 1000 ?
      `${integer.format(ms)} ms`
    : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(ms / 1000)} s`
}

const premium = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })
export const formatPremium = (value: number) => premium.format(value)

export const plural = (count: number, word: string) =>
  `${integer.format(count)} ${word}${count === 1 ? '' : 's'}`
