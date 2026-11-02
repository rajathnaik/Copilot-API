import { useState } from 'react'
import type { UsageSeries, UsageSummary } from '@modelbridge/runtime/usage'
import { formatDay, formatInteger, formatTokens } from './format'

type Mode = 'total' | 'models' | 'clients'

const palette = [
  '#2563eb',
  '#d97706',
  '#059669',
  '#db2777',
  '#7c3aed',
  '#64748b',
]
const width = 640
const height = 220
const margin = { top: 12, right: 16, bottom: 28, left: 56 }
const plotWidth = width - margin.left - margin.right
const plotHeight = height - margin.top - margin.bottom

// Rounds the axis maximum up to 1, 2, 2.5 or 5 times a power of ten.
function niceMax(value: number) {
  if (value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  const step = [1, 2, 2.5, 5, 10].find((item) => item * power >= value) ?? 10
  return step * power
}

// Shows the largest lines and folds the rest into "Other" to keep the chart
// readable.
function visibleLines(lines: UsageSeries[], days: number): UsageSeries[] {
  if (lines.length <= palette.length) return lines
  const kept = lines.slice(0, palette.length - 1)
  const rest = lines.slice(palette.length - 1)
  const sum = (key: 'tokens' | 'requests' | 'premium') =>
    Array.from({ length: days }, (_, index) =>
      rest.reduce((total, line) => total + (line[key][index] ?? 0), 0),
    )
  return [
    ...kept,
    {
      name: `Other (${rest.length})`,
      tokens: sum('tokens'),
      requests: sum('requests'),
      premium: sum('premium'),
    },
  ]
}

export function UsageChart({
  summary,
  host,
}: {
  summary: UsageSummary
  host: boolean
}) {
  const [mode, setMode] = useState<Mode>('total')
  const days = summary.daily.length
  const effective: Mode = mode === 'clients' && !host ? 'total' : mode
  const lines: UsageSeries[] =
    effective === 'total' ?
      [
        {
          name: 'All tokens',
          tokens: summary.daily.map((day) => day.totalTokens),
          requests: summary.daily.map((day) => day.requests),
          premium: summary.daily.map((day) => day.premiumRequests),
        },
      ]
    : visibleLines(summary.series[effective], days)
  const peak = niceMax(Math.max(0, ...lines.flatMap((line) => line.tokens)))
  const x = (index: number) =>
    margin.left + (days <= 1 ? plotWidth / 2 : (index / (days - 1)) * plotWidth)
  const y = (value: number) =>
    margin.top + plotHeight - (value / peak) * plotHeight
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((share) => share * peak)
  const labelCount = Math.min(days, 7)
  const labels = [
    ...new Set(
      Array.from({ length: labelCount }, (_, index) =>
        labelCount <= 1 ? 0 : (
          Math.round((index * (days - 1)) / (labelCount - 1))
        ),
      ),
    ),
  ]
  const busiest = summary.daily.reduce(
    (best, day) => (day.totalTokens > best.totalTokens ? day : best),
    summary.daily[0] ?? { date: '', totalTokens: 0 },
  )
  const modes: Array<{ id: Mode; label: string }> = [
    { id: 'total', label: 'Total' },
    { id: 'models', label: 'By model' },
    ...(host ? [{ id: 'clients' as const, label: 'By client' }] : []),
  ]
  return (
    <section className="usage-chart">
      <div className="section-head">
        <h2>Tokens per day</h2>
        <div className="segmented" role="group" aria-label="Chart grouping">
          {modes.map((item) => (
            <button
              key={item.id}
              aria-pressed={effective === item.id}
              onClick={() => setMode(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      {effective === 'clients' && !lines.length ?
        <p className="muted">
          No remote client requests in this range. Client machines appear here
          after they send requests through the host URL.
        </p>
      : <div className="chart">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            data-days={days}
            data-lines={lines.length}
            role="img"
            aria-label={
              busiest.totalTokens ?
                `Daily tokens. Busiest day ${formatDay(busiest.date)} with ${formatTokens(busiest.totalTokens)} tokens.`
              : 'No tokens recorded in this range.'
            }
          >
            {ticks.map((tick) => (
              <g key={tick} className="y-tick">
                <line
                  x1={margin.left}
                  x2={width - margin.right}
                  y1={y(tick)}
                  y2={y(tick)}
                />
                <text
                  x={margin.left - 8}
                  y={y(tick)}
                  dy="0.32em"
                  textAnchor="end"
                >
                  {formatTokens(tick)}
                </text>
              </g>
            ))}
            <line
              className="axis"
              x1={margin.left}
              x2={width - margin.right}
              y1={margin.top + plotHeight}
              y2={margin.top + plotHeight}
            />
            {labels.map((index) => (
              <text
                key={index}
                className="x-tick"
                x={x(index)}
                y={height - 8}
                textAnchor={
                  days > 1 && index === 0 ? 'start'
                  : days > 1 && index === days - 1 ?
                    'end'
                  : 'middle'
                }
              >
                {formatDay(summary.daily[index]?.date ?? '')}
              </text>
            ))}
            {lines.map((line, lineIndex) => {
              const color = palette[lineIndex % palette.length]
              return (
                <g key={line.name} className="series">
                  {days > 1 && (
                    <polyline
                      fill="none"
                      stroke={color}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      points={line.tokens
                        .map((value, index) => `${x(index)},${y(value)}`)
                        .join(' ')}
                    />
                  )}
                  {days <= 31
                    && line.tokens.map((value, index) => (
                      <circle
                        key={index}
                        className="point"
                        cx={x(index)}
                        cy={y(value)}
                        r={3}
                        fill={color}
                      >
                        <title>
                          {`${line.name}, ${formatDay(summary.daily[index]?.date ?? '')}: ${formatInteger(value)} tokens, ${formatInteger(line.requests[index] ?? 0)} requests`}
                        </title>
                      </circle>
                    ))}
                </g>
              )
            })}
          </svg>
          {effective !== 'total' && (
            <ul className="legend">
              {lines.map((line, index) => (
                <li key={line.name}>
                  <span
                    className="swatch"
                    style={{ background: palette[index % palette.length] }}
                  />
                  {line.name}
                  <span className="muted">
                    {' '}
                    ·{' '}
                    {formatTokens(
                      line.tokens.reduce((sum, value) => sum + value, 0),
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      }
    </section>
  )
}
