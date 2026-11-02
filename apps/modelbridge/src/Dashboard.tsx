import { useCallback, useEffect, useState } from 'react'
import type { Role } from '@modelbridge/runtime/contracts'
import type { CopilotQuotaDetail } from '@modelbridge/runtime/copilot'
import type {
  UsageRange,
  UsageRecord,
  UsageSummary,
  UsageTotals,
} from '@modelbridge/runtime/usage'
import type { CopilotQuotaStatus, UsageReport } from './types'
import { ClientUsage } from './ClientUsage'
import {
  failure,
  formatDateTime,
  formatDay,
  formatDuration,
  formatInteger,
  formatPercent,
  formatPremium,
  formatTime,
  formatTokens,
  formatUsd,
  plural,
} from './format'
import { UsageChart } from './UsageChart'

const ranges: Array<{ id: UsageRange; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
]

const purposes: Record<UsageRecord['purpose'], string> = {
  request: 'Request',
  continuation: 'Tool round',
  'web-search': 'Web search',
}

// Prompts are billed as premium requests; follow-ups the agent sends after
// tool output are not.
function requestType(record: UsageRecord) {
  if (record.purpose !== 'request' || !record.initiator)
    return purposes[record.purpose]
  return record.initiator === 'user' ? 'Prompt' : 'Follow-up'
}

const cost = (totals: UsageTotals) =>
  totals.costUsd === null ? '—' : formatUsd(totals.costUsd)

const cachedShare = (totals: UsageTotals) =>
  totals.inputTokens ? totals.cachedInputTokens / totals.inputTokens : 0

function Metric({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail: string
}) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <strong className="metric-value">{value}</strong>
      <span className="muted">{detail}</span>
    </div>
  )
}

function QuotaMeter({
  label,
  detail,
}: {
  label: string
  detail: CopilotQuotaDetail | null
}) {
  if (!detail) return null
  if (detail.unlimited)
    return (
      <div className="quota-row">
        <span>{label}</span>
        <span className="muted">Unlimited</span>
      </div>
    )
  const share =
    detail.percentRemaining !== null ? detail.percentRemaining / 100
    : detail.entitlement && detail.remaining !== null ?
      detail.remaining / detail.entitlement
    : null
  return (
    <div className="quota-row">
      <span>{label}</span>
      {share !== null && (
        <meter
          min={0}
          max={1}
          low={0.2}
          high={0.5}
          optimum={1}
          value={Math.max(0, Math.min(1, share))}
          aria-label={`${label} remaining`}
        />
      )}
      <span className="numeric">
        {detail.remaining !== null && detail.entitlement !== null ?
          `${formatInteger(Math.max(0, detail.remaining))} of ${formatInteger(detail.entitlement)} left`
        : share !== null ?
          `${formatPercent(share)} left`
        : 'Not reported'}
        {detail.overageCount > 0
          && ` · ${formatInteger(detail.overageCount)} over`}
      </span>
    </div>
  )
}

function QuotaCard({
  quotas,
  error,
  refreshing,
  onRefresh,
}: {
  quotas: CopilotQuotaStatus[] | null
  error: string
  refreshing: boolean
  onRefresh: () => void
}) {
  return (
    <section className="quota">
      <div className="section-head">
        <h2>Copilot quota</h2>
        <button disabled={refreshing || !quotas?.length} onClick={onRefresh}>
          {refreshing ? 'Refreshing…' : 'Refresh quota'}
        </button>
      </div>
      {error && <p className="notice warn">{error}</p>}
      {quotas === null && !error && <p className="muted">Loading quota…</p>}
      {quotas?.length === 0 && (
        <p className="muted">Sign in to Copilot to see your plan quota.</p>
      )}
      {quotas?.map((item) => (
        <div className="quota-source" key={item.sourceId}>
          <p>
            <strong>{item.label}</strong>
            {item.quota?.plan && (
              <span className="muted"> · {item.quota.plan} plan</span>
            )}
            {item.quota?.login && (
              <span className="muted"> · {item.quota.login}</span>
            )}
          </p>
          {item.error && <p className="notice warn">{item.error}</p>}
          {item.quota && (
            <>
              <QuotaMeter
                label="Premium requests"
                detail={item.quota.premium}
              />
              <QuotaMeter label="Chat" detail={item.quota.chat} />
              <QuotaMeter label="Completions" detail={item.quota.completions} />
              <p className="muted">
                {item.quota.resetDate ?
                  `Resets ${formatDay(item.quota.resetDate.slice(0, 10))}. `
                : ''}
                Checked {formatTime(item.quota.checkedAt)}.
              </p>
            </>
          )}
        </div>
      ))}
    </section>
  )
}

function ModelTable({ summary }: { summary: UsageSummary }) {
  return (
    <section>
      <h2>By model</h2>
      <div className="table">
        <table className="numeric-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Source</th>
              <th>Requests</th>
              <th>Input</th>
              <th>Cached</th>
              <th>Output</th>
              <th>Est. cost</th>
              <th>Avg. time</th>
            </tr>
          </thead>
          <tbody>
            {summary.models.map((row) => (
              <tr key={`${row.source}/${row.model}`}>
                <td>
                  <code>{row.model}</code>
                </td>
                <td>{row.source}</td>
                <td>
                  {formatInteger(row.requests)}
                  {row.failed > 0 && (
                    <span className="muted"> ({row.failed} failed)</span>
                  )}
                </td>
                <td>{formatTokens(row.inputTokens)}</td>
                <td>{formatPercent(cachedShare(row))}</td>
                <td>{formatTokens(row.outputTokens)}</td>
                <td>{cost(row)}</td>
                <td>{formatDuration(row.averageDurationMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function AccessSplit({ summary }: { summary: UsageSummary }) {
  const rows = [
    { label: 'This machine', totals: summary.access.local },
    { label: 'Remote clients', totals: summary.access.remote },
  ]
  return (
    <section>
      <h2>Who used it</h2>
      <dl className="pairs">
        {rows.map((row) => (
          <div className="pair" key={row.label}>
            <dt>{row.label}</dt>
            <dd className="numeric">
              {plural(row.totals.requests, 'request')} ·{' '}
              {formatTokens(row.totals.totalTokens)} tokens · {cost(row.totals)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function RecentTable({ summary }: { summary: UsageSummary }) {
  return (
    <section>
      <h2>Recent requests</h2>
      <div className="table">
        <table className="numeric-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Model</th>
              <th>Type</th>
              <th>Result</th>
              <th>Input</th>
              <th>Output</th>
              <th>Time taken</th>
              <th>Est. cost</th>
            </tr>
          </thead>
          <tbody>
            {summary.recent.map((record, index) => (
              <tr key={`${record.at}-${index}`}>
                <td>{formatDateTime(record.at)}</td>
                <td>
                  <code>{record.model}</code>
                  <span className="muted">
                    {' '}
                    · {record.source}
                    {record.access === 'remote' ?
                      ` · remote${record.client ? ` · ${record.client}` : ''}`
                    : ''}
                  </span>
                </td>
                <td>
                  {requestType(record)}
                  {!!record.premium && (
                    <span className="muted">
                      {' '}
                      · {formatPremium(record.premium)} premium
                    </span>
                  )}
                </td>
                <td className={`outcome ${record.outcome}`}>
                  {record.outcome === 'completed' ?
                    'Completed'
                  : record.outcome === 'cancelled' ?
                    'Cancelled'
                  : `Failed${record.status ? ` (${record.status})` : ''}`}
                </td>
                <td>{formatTokens(record.inputTokens)}</td>
                <td>{formatTokens(record.outputTokens)}</td>
                <td>{formatDuration(record.durationMs)}</td>
                <td>
                  {record.nanoAiu === null ?
                    '—'
                  : formatUsd(record.nanoAiu / 100_000_000_000)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export function Dashboard({
  role,
  active,
  onConfigureCodex,
}: {
  role: Role
  active: boolean
  onConfigureCodex: () => void
}) {
  const [range, setRange] = useState<UsageRange>('7d')
  const [report, setReport] = useState<UsageReport | null>(null)
  const [usageError, setUsageError] = useState('')
  const [quotas, setQuotas] = useState<CopilotQuotaStatus[] | null>(null)
  const [quotaError, setQuotaError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    if (!active) return
    let live = true
    let pending = false
    const load = () => {
      if (pending) return
      pending = true
      window.modelbridge
        .usage(range)
        .then((result) => {
          if (!live) return
          if (result.ok) {
            setReport(result.value)
            setUsageError('')
          } else setUsageError(result.error)
        })
        .catch((error: unknown) => {
          if (live) setUsageError(failure(error, 'Could not read usage.'))
        })
        .finally(() => {
          pending = false
        })
    }
    load()
    const timer = setInterval(load, 5000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [active, range])

  const loadQuota = useCallback(async (refresh: boolean) => {
    try {
      const result = await window.modelbridge.copilotQuota(refresh)
      if (result.ok) {
        setQuotas(result.value)
        setQuotaError('')
      } else setQuotaError(result.error)
    } catch (error) {
      setQuotaError(failure(error, 'Could not read Copilot quota.'))
    }
  }, [])

  useEffect(() => {
    if (!active || role !== 'host') return
    void loadQuota(false)
    const timer = setInterval(() => void loadQuota(false), 60_000)
    return () => clearInterval(timer)
  }, [active, role, loadQuota])

  const summary = report?.summary.range === range ? report.summary : null
  const totals = summary?.totals
  return (
    <>
      <div className="dashboard-head">
        <div>
          <h2>Usage</h2>
          <p className="muted">
            {role === 'host' ?
              'Every request this machine sends to Copilot, including requests from remote clients.'
            : 'Every request coding tools on this machine sent through ModelBridge.'
            }
          </p>
        </div>
        <div className="segmented" role="group" aria-label="Usage range">
          {ranges.map((item) => (
            <button
              key={item.id}
              aria-pressed={range === item.id}
              onClick={() => setRange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      {usageError && (
        <p className="notice warn" role="status">
          {usageError}
        </p>
      )}
      {report?.error && (
        <p className="notice warn" role="status">
          Usage history could not be saved: {report.error}
        </p>
      )}
      {!summary || !totals ?
        <section className="starting" role="status" aria-live="polite">
          <p>Loading usage…</p>
        </section>
      : <>
          <div className="metrics">
            <Metric
              label="Requests"
              value={formatInteger(totals.requests)}
              detail={`${formatInteger(totals.failed)} failed · ${plural(totals.webSearches, 'web search')}`}
            />
            <Metric
              label="Premium requests"
              value={formatPremium(totals.premiumRequests)}
              detail={`${plural(totals.prompts, 'prompt')} · ${plural(totals.followUps, 'follow-up')}`}
            />
            <Metric
              label="Input tokens"
              value={formatTokens(totals.inputTokens)}
              detail={`${formatPercent(cachedShare(totals))} from cache`}
            />
            <Metric
              label="Output tokens"
              value={formatTokens(totals.outputTokens)}
              detail={`${formatTokens(totals.reasoningTokens)} reasoning`}
            />
            <Metric
              label="Estimated cost"
              value={cost(totals)}
              detail={`${formatInteger(totals.costedRequests)} of ${formatInteger(totals.requests)} priced`}
            />
            <Metric
              label="Average time"
              value={formatDuration(totals.averageDurationMs)}
              detail={
                totals.unreported ?
                  `${formatInteger(totals.unreported)} without token counts`
                : 'All token counts reported'
              }
            />
          </div>
          {role === 'host' && (
            <QuotaCard
              quotas={quotas}
              error={quotaError}
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true)
                void loadQuota(true).finally(() => setRefreshing(false))
              }}
            />
          )}
          {totals.requests === 0 ?
            <section className="empty">
              <h2>No requests in this range</h2>
              <p className="muted">
                Usage appears here as soon as Codex or another coding tool sends
                a request through ModelBridge.
              </p>
              <button className="primary" onClick={onConfigureCodex}>
                Configure Codex
              </button>
            </section>
          : <>
              <UsageChart summary={summary} host={role === 'host'} />
              <ModelTable summary={summary} />
              {role === 'host' && <AccessSplit summary={summary} />}
            </>
          }
          {role === 'host' && report && (
            <ClientUsage
              clients={report.clients}
              limits={report.limits}
              models={[...new Set(summary.models.map((row) => row.model))]}
              onLimitsSaved={(limits) =>
                setReport((current) => current && { ...current, limits })
              }
            />
          )}
          {totals.requests > 0 && <RecentTable summary={summary} />}
          <p className="muted footnote">
            Estimated cost uses the AI units Copilot reports with each response,
            converted at 100 AI units per US dollar (the original gateway&apos;s
            rate). Requests without reported AI units are not priced. Token
            counts include web-search and tool-round requests made on your
            behalf.
          </p>
        </>
      }
    </>
  )
}
