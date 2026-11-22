import { useState } from 'react'
import type {
  ClientLimitStatus,
  LimitState,
  PremiumLimits,
} from '@modelbridge/runtime/limits'
import {
  failure,
  formatCredits,
  formatDateTime,
  formatInteger,
  formatPremium,
  plural,
} from './format'

const states: Record<LimitState, string> = {
  none: 'No limit',
  ok: 'Within limit',
  near: 'Near limit',
  over: 'Over limit',
}

function Badge({
  state,
  incomplete = false,
}: {
  state: LimitState
  incomplete?: boolean
}) {
  const uncertain = incomplete && state === 'ok'
  return (
    <span className={`badge ${uncertain ? 'near' : state}`}>
      {uncertain ? 'Incomplete' : states[state]}
    </span>
  )
}

const used = (amount: number, limit: number | null, credits: boolean) => {
  const format = credits ? formatCredits : formatPremium
  return limit === null ?
      format(amount)
    : `${format(amount)} of ${format(limit)}`
}

function parseLimit(value: string): number | null | undefined {
  if (!value.trim()) return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function LimitsEditor({
  limits,
  clients,
  models,
  onSaved,
}: {
  limits: PremiumLimits
  clients: string[]
  models: string[]
  onSaved: (limits: PremiumLimits) => void
}) {
  const [draft, setDraft] = useState(limits)
  const [unit, setUnit] = useState(limits.unit ?? 'premium-requests')
  const [defaultText, setDefaultText] = useState(
    limits.defaultMonthly === null ? '' : String(limits.defaultMonthly),
  )
  const [clientName, setClientName] = useState('')
  const [clientLimit, setClientLimit] = useState('')
  const [model, setModel] = useState('')
  const [modelLimit, setModelLimit] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const save = async (next: PremiumLimits) => {
    setSaving(true)
    setMessage('')
    try {
      const result = await window.modelbridge.setPremiumLimits(next)
      if (result.ok) {
        setDraft(result.value)
        onSaved(result.value)
        setMessage('Limits saved.')
        return true
      }
      setMessage(result.error)
    } catch (error) {
      setMessage(failure(error, 'Could not save limits.'))
    } finally {
      setSaving(false)
    }
    return false
  }
  const defaultValue = parseLimit(defaultText)
  const clientValue = parseLimit(clientLimit)
  const modelValue = parseLimit(modelLimit)
  const unitLabel =
    draft.unit === 'credits' ? 'Copilot credits' : 'premium requests'
  const without = <T,>(record: Record<string, T>, key: string) =>
    Object.fromEntries(Object.entries(record).filter(([name]) => name !== key))
  return (
    <details className="limits-editor">
      <summary>Client usage limits</summary>
      <p className="muted">
        Monthly {unitLabel} each client may use. Limits only warn here; requests
        are never blocked. Months follow this computer&apos;s calendar.
      </p>
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault()
          void save({ ...draft, unit })
        }}
      >
        <label>
          Budget unit
          <select
            name="budgetUnit"
            value={unit}
            onChange={(event) =>
              setUnit(
                event.target.value === 'credits' ?
                  'credits'
                : 'premium-requests',
              )
            }
          >
            <option value="credits">Copilot credits</option>
            <option value="premium-requests">Legacy premium requests</option>
          </select>
        </label>
        <button
          disabled={saving || unit === (draft.unit ?? 'premium-requests')}
          type="submit"
        >
          Save budget unit
        </button>
      </form>
      {unit !== (draft.unit ?? 'premium-requests') && (
        <p className="notice warn">
          Changing units keeps the numeric limits unchanged; review every limit
          before saving. Credits are not equivalent to premium requests.
        </p>
      )}
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (defaultValue === undefined) return
          void save({ ...draft, defaultMonthly: defaultValue })
        }}
      >
        <label>
          Default limit per client
          <input
            name="defaultMonthly"
            inputMode="decimal"
            placeholder="No limit"
            value={defaultText}
            aria-invalid={defaultValue === undefined}
            onChange={(event) => setDefaultText(event.target.value)}
          />
        </label>
        <button disabled={saving || defaultValue === undefined} type="submit">
          Save default
        </button>
      </form>

      <h3>Client overrides</h3>
      {Object.keys(draft.clients).length > 0 && (
        <ul className="limit-list">
          {Object.entries(draft.clients).map(([name, limit]) => (
            <li key={name}>
              <span>{name}</span>
              <span className="numeric">
                {limit === null ? 'No limit' : formatPremium(limit)}
              </span>
              <button
                disabled={saving}
                aria-label={`Remove the limit for ${name}`}
                onClick={() =>
                  void save({ ...draft, clients: without(draft.clients, name) })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault()
          const name = clientName.trim()
          if (!name || clientValue === undefined) return
          void save({
            ...draft,
            clients: { ...draft.clients, [name]: clientValue },
          }).then((saved) => {
            if (!saved) return
            setClientName('')
            setClientLimit('')
          })
        }}
      >
        <label>
          Client
          <input
            name="client"
            list="limit-clients"
            maxLength={64}
            autoComplete="off"
            value={clientName}
            onChange={(event) => setClientName(event.target.value)}
          />
          <datalist id="limit-clients">
            {clients.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
        <label>
          Monthly limit
          <input
            name="clientLimit"
            inputMode="decimal"
            placeholder="No limit"
            value={clientLimit}
            aria-invalid={clientValue === undefined}
            onChange={(event) => setClientLimit(event.target.value)}
          />
        </label>
        <button
          disabled={saving || !clientName.trim() || clientValue === undefined}
          type="submit"
        >
          Set client limit
        </button>
      </form>

      <h3>Per-model limits</h3>
      <p className="muted">Apply to each client separately.</p>
      {Object.keys(draft.models).length > 0 && (
        <ul className="limit-list">
          {Object.entries(draft.models).map(([name, limit]) => (
            <li key={name}>
              <code>{name}</code>
              <span className="numeric">{formatPremium(limit)}</span>
              <button
                disabled={saving}
                aria-label={`Remove the limit for ${name}`}
                onClick={() =>
                  void save({ ...draft, models: without(draft.models, name) })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="inline-form"
        onSubmit={(event) => {
          event.preventDefault()
          const name = model.trim()
          if (!name || modelValue === undefined || modelValue === null) return
          void save({
            ...draft,
            models: { ...draft.models, [name]: modelValue },
          }).then((saved) => {
            if (!saved) return
            setModel('')
            setModelLimit('')
          })
        }}
      >
        <label>
          Model
          <input
            name="model"
            list="limit-models"
            autoComplete="off"
            spellCheck={false}
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />
          <datalist id="limit-models">
            {models.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
        <label>
          Monthly limit
          <input
            name="modelLimit"
            inputMode="decimal"
            value={modelLimit}
            aria-invalid={modelValue === undefined}
            onChange={(event) => setModelLimit(event.target.value)}
          />
        </label>
        <button
          disabled={
            saving
            || !model.trim()
            || modelValue === undefined
            || modelValue === null
          }
          type="submit"
        >
          Set model limit
        </button>
      </form>
      {message && <p role="status">{message}</p>}
    </details>
  )
}

export function ClientUsage({
  clients,
  limits,
  models,
  onLimitsSaved,
}: {
  clients: ClientLimitStatus[]
  limits: PremiumLimits
  models: string[]
  onLimitsSaved: (limits: PremiumLimits) => void
}) {
  const unitLabel =
    limits.unit === 'credits' ? 'Copilot credits' : 'premium requests'
  const warnings = clients.filter(
    (client) =>
      client.state === 'over'
      || client.state === 'near'
      || client.models.some(
        (item) => item.state === 'over' || item.state === 'near',
      ),
  )
  return (
    <section className="clients">
      <h2>Client machines this month</h2>
      {warnings.length > 0 && (
        <p className="notice warn" role="status">
          {warnings
            .map((client) => {
              const over =
                client.state === 'over'
                || client.models.some((item) => item.state === 'over')
              return `${client.client} is ${over ? 'over' : 'near'} its ${unitLabel} limit`
            })
            .join('. ')}
          .
        </p>
      )}
      {limits.unit === 'credits'
        && clients.some((client) => client.unpricedRequests > 0) && (
          <p className="notice warn" role="status">
            Some requests did not report AI credits. Budgets count reported
            credits only and may understate consumption; GitHub&apos;s account
            quota remains the authority.
          </p>
        )}
      {!clients.length ?
        <p className="muted">
          No client machine has used this host this month. Each client reports
          the name set in its Settings tab.
        </p>
      : <div className="table">
          <table className="numeric-table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Last seen</th>
                <th>Requests</th>
                <th>{unitLabel}</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => (
                <tr key={client.client}>
                  <td>
                    <strong>{client.client}</strong>
                    {client.models.length > 0 && (
                      <details className="client-models">
                        <summary>
                          {plural(client.models.length, 'model')}
                        </summary>
                        <ul>
                          {client.models.map((item) => (
                            <li key={item.model}>
                              <code>{item.model}</code>{' '}
                              <span className="numeric">
                                {used(
                                  item.used,
                                  item.limit,
                                  limits.unit === 'credits',
                                )}
                              </span>{' '}
                              {item.state !== 'none' && (
                                <Badge
                                  state={item.state}
                                  incomplete={
                                    limits.unit === 'credits'
                                    && client.unpricedRequests > 0
                                  }
                                />
                              )}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </td>
                  <td>
                    {client.lastSeen === null ?
                      '—'
                    : formatDateTime(client.lastSeen)}
                  </td>
                  <td>{formatInteger(client.requests)}</td>
                  <td>
                    {(
                      limits.unit === 'credits'
                      && client.unpricedRequests === client.requests
                      && client.requests > 0
                    ) ?
                      'Not reported'
                    : used(client.used, client.limit, limits.unit === 'credits')
                    }
                    {limits.unit === 'credits'
                      && client.unpricedRequests > 0 && (
                        <span className="muted">
                          {' '}
                          · {plural(client.unpricedRequests, 'request')} without
                          credits
                        </span>
                      )}
                  </td>
                  <td>
                    <Badge
                      state={client.state}
                      incomplete={
                        limits.unit === 'credits' && client.unpricedRequests > 0
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      }
      <LimitsEditor
        limits={limits}
        clients={clients.map((client) => client.client)}
        models={models}
        onSaved={onLimitsSaved}
      />
    </section>
  )
}
