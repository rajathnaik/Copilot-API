import { useState } from 'react'
import type {
  ClientLimitStatus,
  LimitState,
  PremiumLimits,
} from '@modelbridge/runtime/limits'
import {
  failure,
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

function Badge({ state }: { state: LimitState }) {
  return <span className={`badge ${state}`}>{states[state]}</span>
}

const used = (premium: number, limit: number | null) =>
  limit === null ?
    formatPremium(premium)
  : `${formatPremium(premium)} of ${formatPremium(limit)}`

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
  const without = <T,>(record: Record<string, T>, key: string) =>
    Object.fromEntries(Object.entries(record).filter(([name]) => name !== key))
  return (
    <details className="limits-editor">
      <summary>Premium request limits</summary>
      <p className="muted">
        Monthly Copilot premium requests each client may use. Limits only warn
        here; requests are never blocked. Months follow this computer&apos;s
        calendar.
      </p>
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
              return `${client.client} is ${over ? 'over' : 'near'} its premium request limit`
            })
            .join('. ')}
          .
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
                <th>Premium requests</th>
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
                                {used(item.premium, item.limit)}
                              </span>{' '}
                              {item.state !== 'none' && (
                                <Badge state={item.state} />
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
                  <td>{used(client.premium, client.limit)}</td>
                  <td>
                    <Badge state={client.state} />
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
