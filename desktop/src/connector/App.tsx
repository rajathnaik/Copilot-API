import { useEffect, useState } from 'react'
import { useLanguage } from '../contexts/LanguageContext'
import type {
  ConnectorDiscovery,
  ConnectorResult,
  ConnectorStatus,
} from '../types/connector'
import icon from '../../assets/app-icon.svg'

type Action = 'connect' | 'discover' | 'refresh' | 'undo' | 'detect' | null

function unwrap<T>(result: ConnectorResult<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}

export default function ConnectorApp() {
  const { t, langPref, setLangPref } = useLanguage()
  const [status, setStatus] = useState<ConnectorStatus | null>(null)
  const [url, setUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [discovery, setDiscovery] = useState<ConnectorDiscovery | null>(null)
  const [action, setAction] = useState<Action>('detect')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [confirmUndo, setConfirmUndo] = useState(false)

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () =>
      document.documentElement.classList.toggle('dark', media.matches)
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [])

  useEffect(() => {
    let active = true
    if (!window.connectorAPI) {
      setError(t('connector.noBridge'))
      setAction(null)
      return
    }
    window.connectorAPI
      .status()
      .then((result) => {
        if (!active) return
        const next = unwrap(result)
        setStatus(next)
        setUrl(next.connection?.baseUrl ?? '')
        setModel(next.connection?.model ?? '')
      })
      .catch((failure: unknown) => {
        if (active)
          setError(
            failure instanceof Error ?
              failure.message
            : t('connector.noBridge'),
          )
      })
      .finally(() => {
        if (active) setAction(null)
      })
    return () => {
      active = false
    }
    // Initial detection should not replace user input on language changes.
  }, [])

  async function perform(nextAction: Exclude<Action, null>) {
    setAction(nextAction)
    setError('')
    setNotice('')
    try {
      if (!window.connectorAPI) throw new Error(t('connector.noBridge'))
      if (nextAction === 'detect') {
        setStatus(unwrap(await window.connectorAPI.status()))
      } else if (nextAction === 'discover') {
        const next = unwrap(await window.connectorAPI.discover({ url, apiKey }))
        setDiscovery(next)
        if (model && !next.models.some((candidate) => candidate.id === model))
          setModel('')
      } else if (nextAction === 'undo') {
        unwrap(await window.connectorAPI.undo())
        setStatus((previous) =>
          previous ? { ...previous, connection: null } : previous,
        )
        setApiKey('')
        setModel('')
        setDiscovery(null)
        setConfirmUndo(false)
        setNotice(t('connector.undone'))
      } else {
        const connection = unwrap(
          nextAction === 'refresh' ?
            await window.connectorAPI.refresh()
          : await window.connectorAPI.connect({
              url,
              apiKey,
              model: model || discovery?.defaultModel,
            }),
        )
        setStatus((previous) =>
          previous ? { ...previous, connection } : previous,
        )
        setUrl(connection.baseUrl)
        setModel(connection.model)
        setApiKey('')
        setShowKey(false)
        setDiscovery(null)
        setNotice(t('connector.restartNotice'))
      }
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : t('connector.noBridge'),
      )
    } finally {
      setAction(null)
    }
  }

  async function selectExecutable() {
    setAction('detect')
    setError('')
    try {
      setStatus(unwrap(await window.connectorAPI.selectCodex()))
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : t('connector.noBridge'),
      )
    } finally {
      setAction(null)
    }
  }

  const busy = action !== null
  const canConnect =
    !busy
    && !!status?.installation
    && status.secureStorage
    && !!url.trim()
    && !!apiKey.trim()
  const connection = status?.connection
  const inputClass =
    'w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-ink-soft disabled:opacity-50'
  const buttonClass =
    'rounded-xl border border-line px-4 py-2.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ink-soft disabled:cursor-not-allowed disabled:opacity-50'

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <header className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <img src={icon} width="44" height="44" alt="" />
          <div>
            <h1 className="text-xl font-semibold">{t('connector.title')}</h1>
            <p className="mt-2 max-w-lg text-sm text-ink-soft">
              {t('connector.subtitle')}
            </p>
          </div>
        </div>
        <label className="text-xs text-ink-soft">
          {t('connector.language')}
          <select
            className={`${inputClass} mt-1`}
            value={langPref}
            onChange={(event) => {
              const preference = event.target.value
              if (
                preference === 'auto'
                || preference === 'en'
                || preference === 'zh'
              )
                setLangPref(preference)
            }}
          >
            <option value="auto">Auto</option>
            <option value="en">English</option>
            <option value="zh">中文</option>
          </select>
        </label>
      </header>

      <section
        aria-label="Codex"
        className="space-y-4 rounded-2xl border border-line bg-surface p-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold">
            Codex{' '}
            {status?.installation && (
              <span className="ml-2 text-sm font-normal text-ink-soft">
                {status.installation.version}
              </span>
            )}
          </h2>
          <button
            type="button"
            className={buttonClass}
            disabled={busy || !window.connectorAPI}
            onClick={selectExecutable}
          >
            {t('connector.selectExecutable')}
          </button>
        </div>
        {status && !status.installation && (
          <p className="text-sm text-ink-soft">{t('connector.notDetected')}</p>
        )}
        {status && (
          <p
            className={`text-sm ${status.secureStorage ? 'text-ink-soft' : 'text-red-600 dark:text-red-400'}`}
          >
            {t(
              status.secureStorage ?
                'connector.secureReady'
              : 'connector.secureUnavailable',
            )}
          </p>
        )}

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (canConnect) void perform('connect')
          }}
        >
          <div>
            <label
              htmlFor="gateway-url"
              className="mb-1.5 block text-sm font-medium"
            >
              {t('connector.gatewayUrl')}
            </label>
            <input
              id="gateway-url"
              className={inputClass}
              type="url"
              required
              placeholder="https://your-tunnel.devtunnels.ms"
              value={url}
              disabled={busy}
              onChange={(event) => {
                setUrl(event.target.value)
                setDiscovery(null)
                setModel('')
              }}
            />
          </div>
          <div>
            <label
              htmlFor="gateway-key"
              className="mb-1.5 block text-sm font-medium"
            >
              {t('connector.apiKey')}
            </label>
            <div className="flex gap-2">
              <input
                id="gateway-key"
                className={inputClass}
                type={showKey ? 'text' : 'password'}
                required
                autoComplete="off"
                spellCheck={false}
                placeholder={t('connector.keyPlaceholder')}
                value={apiKey}
                disabled={busy}
                onChange={(event) => {
                  setApiKey(event.target.value)
                  setDiscovery(null)
                }}
              />
              <button
                type="button"
                className={`${buttonClass} shrink-0`}
                disabled={busy}
                aria-controls="gateway-key"
                aria-pressed={showKey}
                onClick={() => setShowKey(!showKey)}
              >
                {t(showKey ? 'connector.hideKey' : 'connector.showKey')}
              </button>
            </div>
            {connection && (
              <p className="mt-2 text-xs text-ink-soft">
                {t('connector.savedKeyNote')}
              </p>
            )}
          </div>
          {discovery && (
            <div>
              <label
                htmlFor="default-model"
                className="mb-1.5 block text-sm font-medium"
              >
                {t('connector.defaultModel')}
              </label>
              <select
                id="default-model"
                className={inputClass}
                value={model}
                disabled={busy}
                onChange={(event) => setModel(event.target.value)}
              >
                <option value="">{t('connector.automatic')}</option>
                {discovery.models.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} ({candidate.id})
                  </option>
                ))}
              </select>
              <p className="mt-2 text-xs text-ink-soft">
                {t('connector.modelCount', { count: discovery.models.length })}
              </p>
              {discovery.excludedModels.length > 0 && (
                <p className="mt-2 text-xs text-ink-soft">
                  {t('connector.excludedModels', {
                    count: discovery.excludedModels.length,
                  })}
                </p>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              className={`${buttonClass} bg-ink text-canvas`}
              disabled={!canConnect}
            >
              {t('connector.connect')}
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={
                busy || !status?.installation || !url.trim() || !apiKey.trim()
              }
              onClick={() => perform('discover')}
            >
              {t('connector.discover')}
            </button>
          </div>
        </form>
        <p className="text-xs leading-relaxed text-ink-soft">
          {t('connector.inferenceNotice')}
        </p>
        <p className="text-xs leading-relaxed text-ink-soft">
          {t('connector.configurationNotice')}
        </p>
      </section>

      <div aria-live="polite" aria-atomic="true">
        {busy && (
          <p role="status" className="text-sm text-ink-soft">
            {t(
              action === 'connect' ? 'connector.connecting'
              : action === 'discover' ? 'connector.discovering'
              : action === 'refresh' ? 'connector.refreshing'
              : action === 'undo' ? 'connector.undoing'
              : 'connector.statusLoading',
            )}
          </p>
        )}
        {notice && (
          <p
            role="status"
            className="rounded-xl border border-line bg-surface p-4 text-sm"
          >
            {notice}
          </p>
        )}
      </div>
      {error && (
        <div
          role="alert"
          className="space-y-3 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200"
        >
          <p className="break-words">{error}</p>
          <button
            type="button"
            className={buttonClass}
            disabled={busy || !window.connectorAPI}
            onClick={() => perform('detect')}
          >
            {t('connector.retry')}
          </button>
        </div>
      )}

      {connection && (
        <section className="space-y-4 rounded-2xl border border-line bg-surface p-5">
          <h2 className="font-semibold">{t('connector.connected')}</h2>
          <p className="break-all text-sm text-ink-soft">
            {connection.baseUrl}
          </p>
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-ink-soft">{t('connector.defaultModel')}</dt>
              <dd className="break-all">
                {connection.model} ·{' '}
                {t('connector.modelCount', { count: connection.modelCount })}
              </dd>
            </div>
            <div>
              <dt className="text-ink-soft">{t('connector.catalogMode')}</dt>
              <dd>
                {t(
                  connection.catalogMode === 'remote' ?
                    'connector.remoteCatalog'
                  : 'connector.localCatalog',
                )}
              </dd>
            </div>
            <div>
              <dt className="text-ink-soft">{t('connector.verifiedAt')}</dt>
              <dd>{new Date(connection.verifiedAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-ink-soft">{t('connector.configPath')}</dt>
              <dd className="break-all">{connection.configPath}</dd>
            </div>
          </dl>
          {confirmUndo ?
            <div className="space-y-3">
              <p>{t('connector.confirmUndo')}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => perform('undo')}
                >
                  {t('connector.undo')}
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy}
                  onClick={() => setConfirmUndo(false)}
                >
                  {t('connector.cancel')}
                </button>
              </div>
            </div>
          : <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonClass}
                disabled={
                  busy || !status?.secureStorage || !status.installation
                }
                onClick={() => perform('refresh')}
              >
                {t('connector.refresh')}
              </button>
              <button
                type="button"
                className={buttonClass}
                disabled={busy}
                onClick={() => setConfirmUndo(true)}
              >
                {t('connector.undo')}
              </button>
            </div>
          }
          <p className="text-xs text-ink-soft">
            {t('connector.restartNotice')}
          </p>
        </section>
      )}
      <footer className="space-y-3 text-xs leading-relaxed text-ink-soft">
        <p>{t('connector.hostNotice')}</p>
        <p>{t('connector.wslNotice')}</p>
        <p>
          <strong className="font-medium text-ink">
            {t('connector.otherHarnesses')}
          </strong>{' '}
          — {t('connector.otherHarnessesNote')}
        </p>
      </footer>
    </main>
  )
}
