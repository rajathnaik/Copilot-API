import { useEffect, useState } from 'react'
import { useLanguage } from '../contexts/LanguageContext'
import { useThemePreference } from '../contexts/ThemeContext'
import type { ThemePreference } from '../types/ipc'
import type {
  ConnectorDiscovery,
  ConnectorResult,
  ConnectorStatus,
  ConnectorHarness,
} from '../types/connector'
import {
  CONNECTOR_HARNESSES,
  HARNESS_NAMES,
  isConnectorHarness,
} from '../types/connector'
import icon from '../../assets/connector-icon.svg'

type Action =
  | 'connect'
  | 'discover'
  | 'refresh'
  | 'undo'
  | 'detect'
  | 'auto'
  | 'install'
  | null

const THEME_KEY = 'copilot-api-connector-theme'
function readTheme(): { preference: ThemePreference; failed: boolean } {
  try {
    const preference = window.localStorage.getItem(THEME_KEY)
    if (preference === null) return { preference: 'auto', failed: false }
    if (
      preference === 'auto'
      || preference === 'light'
      || preference === 'dark'
    )
      return { preference, failed: false }
    throw new Error('Invalid saved theme preference.')
  } catch {
    return { preference: 'auto', failed: true }
  }
}

function unwrap<T>(result: ConnectorResult<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}

export default function ConnectorApp() {
  const { t, langPref, setLangPref } = useLanguage()
  const [savedTheme] = useState(readTheme)
  const { themePref, setThemePref } = useThemePreference(savedTheme.preference)
  const [status, setStatus] = useState<ConnectorStatus | null>(null)
  const [harness, setHarness] = useState<ConnectorHarness>('codex')
  const [copyFrom, setCopyFrom] = useState<ConnectorHarness | ''>('')
  const [allowPlaintext, setAllowPlaintext] = useState(false)
  const [url, setUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [discovery, setDiscovery] = useState<ConnectorDiscovery | null>(null)
  const [action, setAction] = useState<Action>('detect')
  const [error, setError] = useState(
    savedTheme.failed ? t('connector.themeLoadFailed') : '',
  )
  const [notice, setNotice] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [confirmUndo, setConfirmUndo] = useState(false)

  useEffect(() => {
    let active = true
    if (!window.connectorAPI) {
      setError(t('connector.noBridge'))
      setAction(null)
      return
    }
    window.connectorAPI
      .status(harness)
      .then((result) => {
        if (!active) return
        const next = unwrap(result)
        setStatus(next)
        setUrl(next.connection?.baseUrl ?? '')
        setModel(next.connection?.model ?? '')
        setAllowPlaintext(next.connection?.credentialMode === 'config')
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
  }, [harness])

  function updateConnection(connection: ConnectorStatus['connection']) {
    setStatus((previous) =>
      previous ?
        {
          ...previous,
          connection,
          profiles: previous.profiles?.map((profile) =>
            profile.harness === harness ? { ...profile, connection } : profile,
          ),
        }
      : previous,
    )
  }

  async function perform(nextAction: Exclude<Action, null>) {
    setAction(nextAction)
    setError('')
    setNotice('')
    try {
      if (!window.connectorAPI) throw new Error(t('connector.noBridge'))
      if (nextAction === 'detect') {
        setStatus(unwrap(await window.connectorAPI.status(harness)))
      } else if (nextAction === 'auto') {
        setStatus(unwrap(await window.connectorAPI.resetExecutable(harness)))
      } else if (nextAction === 'install') {
        unwrap(await window.connectorAPI.openInstallGuide(harness))
      } else if (nextAction === 'discover') {
        const next = unwrap(
          await window.connectorAPI.discover({
            harness,
            url,
            apiKey,
            copyFrom: copyFrom || undefined,
          }),
        )
        setDiscovery(next)
        if (model && !next.models.some((candidate) => candidate.id === model))
          setModel('')
      } else if (nextAction === 'undo') {
        unwrap(await window.connectorAPI.undo(harness))
        updateConnection(null)
        setApiKey('')
        setModel('')
        setDiscovery(null)
        setConfirmUndo(false)
        setCopyFrom('')
        setAllowPlaintext(false)
        setNotice(t('connector.undone'))
      } else {
        const connection = unwrap(
          nextAction === 'refresh' ?
            await window.connectorAPI.refresh(harness)
          : await window.connectorAPI.connect({
              url,
              apiKey,
              model: model || discovery?.defaultModel,
              harness,
              copyFrom: copyFrom || undefined,
              allowPlaintext,
            }),
        )
        updateConnection(connection)
        setUrl(connection.baseUrl)
        setModel(connection.model)
        setApiKey('')
        setShowKey(false)
        setCopyFrom('')
        setDiscovery(null)
        setNotice(
          t(
            connection.credentialMode === 'config' ?
              'connector.plaintextRestartNotice'
            : 'connector.restartNotice',
            {
              harness: HARNESS_NAMES[harness],
            },
          ),
        )
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
      setStatus(unwrap(await window.connectorAPI.selectExecutable(harness)))
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
    && (!!apiKey.trim() || !!copyFrom)
    && (harness !== 'opencode' || allowPlaintext)
  const connection = status?.connection
  const name = HARNESS_NAMES[harness]
  const inputClass =
    'w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-ink-soft disabled:opacity-50'
  const buttonClass =
    'rounded-xl border border-line px-4 py-2.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ink-soft disabled:cursor-not-allowed disabled:opacity-50'

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-60 flex-1 items-start gap-3">
          <img src={icon} width="48" height="48" className="shrink-0" alt="" />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">{t('connector.title')}</h1>
            {status && (
              <p className="mt-1 text-xs text-ink-soft">
                {t('connector.version', { version: status.appVersion })}
              </p>
            )}
            <p className="mt-2 max-w-lg text-sm text-ink-soft">
              {t('connector.subtitle')}
            </p>
          </div>
        </div>
        <div className="flex gap-3">
          <div className="text-xs text-ink-soft">
            <label htmlFor="connector-theme">
              {t('settings.sectionTheme')}
            </label>
            <select
              id="connector-theme"
              className={`${inputClass} mt-1`}
              value={themePref}
              onChange={(event) => {
                const preference = event.target.value
                if (
                  preference !== 'auto'
                  && preference !== 'light'
                  && preference !== 'dark'
                )
                  return
                try {
                  window.localStorage.setItem(THEME_KEY, preference)
                  setThemePref(preference)
                } catch {
                  setError(t('connector.themeSaveFailed'))
                }
              }}
            >
              <option value="auto">{t('settings.themeAuto')}</option>
              <option value="light">{t('settings.themeLight')}</option>
              <option value="dark">{t('settings.themeDark')}</option>
            </select>
          </div>
          <div className="text-xs text-ink-soft">
            <label htmlFor="connector-language">
              {t('connector.language')}
            </label>
            <select
              id="connector-language"
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
          </div>
        </div>
      </header>

      <section
        aria-label={name}
        className="space-y-4 rounded-2xl border border-line bg-surface p-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-48">
            <label
              htmlFor="connector-harness"
              className="mb-1.5 block text-sm font-medium"
            >
              {t('connector.harness')}
            </label>
            <select
              id="connector-harness"
              className={inputClass}
              value={harness}
              disabled={busy}
              onChange={(event) => {
                if (
                  !isConnectorHarness(event.target.value)
                  || event.target.value === harness
                )
                  return
                setHarness(event.target.value)
                setStatus(null)
                setUrl('')
                setApiKey('')
                setModel('')
                setDiscovery(null)
                setCopyFrom('')
                setAllowPlaintext(false)
                setShowKey(false)
                setConfirmUndo(false)
                setError('')
                setNotice('')
                setAction('detect')
              }}
            >
              {CONNECTOR_HARNESSES.map((id) => (
                <option key={id} value={id}>
                  {HARNESS_NAMES[id]}
                  {(
                    status?.profiles?.some(
                      (profile) => profile.harness === id && profile.connection,
                    )
                  ) ?
                    ' ✓'
                  : ''}
                </option>
              ))}
            </select>
            {status?.installation && (
              <span className="mt-2 block text-xs text-ink-soft">
                {status.installation.version}
              </span>
            )}
          </div>
          {status?.installation && (
            <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
              {t('connector.detected')}
            </span>
          )}
        </div>
        {status && !status.installation && (
          <div className="space-y-3">
            <p className="text-sm text-ink-soft">
              {t(
                harness === 'codex' ?
                  'connector.notDetected'
                : 'connector.harnessNotDetected',
                { harness: name },
              )}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonClass}
                disabled={busy}
                onClick={() => perform('install')}
              >
                {t('connector.installGuide', { harness: name })}
              </button>
              <button
                type="button"
                className={buttonClass}
                disabled={busy}
                onClick={() => perform('detect')}
              >
                {t('connector.retry')}
              </button>
            </div>
          </div>
        )}
        {status && (
          <div
            className={`text-sm ${status.secureStorage ? 'text-ink-soft' : 'text-red-600 dark:text-red-400'}`}
          >
            {t(
              status.secureStorage ?
                'connector.secureReady'
              : 'connector.secureUnavailable',
            )}
            {status?.profiles
              ?.filter((profile) => profile.error)
              .map((profile) => (
                <p
                  key={profile.harness}
                  role="alert"
                  className="text-sm text-red-600 dark:text-red-400"
                >
                  {profile.error}
                </p>
              ))}
          </div>
        )}

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (canConnect) void perform('connect')
          }}
        >
          {!!status?.profiles?.some((profile) => profile.connection) && (
            <div>
              <label
                htmlFor="saved-gateway"
                className="mb-1.5 block text-sm font-medium"
              >
                {t('connector.reuseGateway')}
              </label>
              <select
                id="saved-gateway"
                className={inputClass}
                value={copyFrom}
                disabled={busy}
                onChange={(event) => {
                  const selected = event.target.value
                  if (selected !== '' && !isConnectorHarness(selected)) return
                  const source = status.profiles?.find(
                    (profile) => profile.harness === selected,
                  )?.connection
                  setCopyFrom(selected)
                  setUrl(source?.baseUrl ?? connection?.baseUrl ?? '')
                  setApiKey('')
                  setModel('')
                  setDiscovery(null)
                  setShowKey(false)
                }}
              >
                <option value="">{t('connector.newGateway')}</option>
                {status.profiles
                  ?.filter((profile) => profile.connection)
                  .map((profile) => (
                    <option key={profile.harness} value={profile.harness}>
                      {HARNESS_NAMES[profile.harness]} —{' '}
                      {profile.connection?.baseUrl}
                    </option>
                  ))}
              </select>
              <p className="mt-2 text-xs text-ink-soft">
                {t('connector.independentProfiles')}
              </p>
            </div>
          )}
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
              readOnly={!!copyFrom}
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
                required={!copyFrom}
                autoComplete="off"
                spellCheck={false}
                placeholder={t('connector.keyPlaceholder')}
                value={apiKey}
                disabled={busy || !!copyFrom}
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
            {harness === 'opencode' && (
              <label className="flex items-start gap-2 rounded-xl border border-amber-300 p-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1 shrink-0"
                  checked={allowPlaintext}
                  disabled={busy}
                  onChange={(event) => setAllowPlaintext(event.target.checked)}
                />
                <span>{t('connector.plaintextConsent')}</span>
              </label>
            )}
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
              {t('connector.connect', { harness: name })}
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={
                busy
                || !status?.installation
                || !url.trim()
                || (!apiKey.trim() && !copyFrom)
              }
              onClick={() => perform('discover')}
            >
              {t('connector.discover')}
            </button>
          </div>
        </form>
        <p className="text-xs leading-relaxed text-ink-soft">
          {t(
            harness === 'codex' ?
              'connector.inferenceNotice'
            : 'connector.protocolInferenceNotice',
          )}
        </p>
        <p className="text-xs leading-relaxed text-ink-soft">
          {t(
            harness === 'codex' ?
              'connector.configurationNotice'
            : 'connector.harnessConfigurationNotice',
          )}
        </p>
        <details
          id="connector-advanced"
          className="rounded-xl border border-line p-4 text-sm"
        >
          <summary className="cursor-pointer font-medium text-ink-soft">
            {t('connector.advanced')}
          </summary>
          <div className="mt-3 space-y-3">
            <p className="text-ink-soft">
              {t('connector.automaticDetection', { harness: name })}
            </p>
            {status?.installation && (
              <p className="break-all text-xs text-ink-soft">
                {status.installation.executable}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={buttonClass}
                disabled={busy || !window.connectorAPI}
                onClick={selectExecutable}
              >
                {t('connector.selectExecutable', { harness: name })}
              </button>
              <button
                type="button"
                className={buttonClass}
                disabled={busy || !window.connectorAPI}
                onClick={() => perform('auto')}
              >
                {t('connector.useAutomaticDetection')}
              </button>
            </div>
          </div>
        </details>
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
              { harness: name },
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
          <h2 className="font-semibold">
            {t('connector.connected', { harness: name })}
          </h2>
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
              <dt className="text-ink-soft">{t('connector.verifiedAt')}</dt>
              <dd>{new Date(connection.verifiedAt).toLocaleString()}</dd>
            </div>
          </dl>
          <details className="text-sm">
            <summary className="cursor-pointer text-ink-soft">
              {t('connector.connectionDetails')}
            </summary>
            <dl className="mt-3 space-y-2">
              <div>
                <dt className="text-ink-soft">{t('connector.catalogMode')}</dt>
                <dd>
                  {t(
                    connection.catalogMode === 'remote' ?
                      'connector.remoteCatalog'
                    : connection.catalogMode === 'local' ?
                      'connector.localCatalog'
                    : 'connector.configuredCatalog',
                  )}
                </dd>
              </div>
              {connection.protocol && (
                <div>
                  <dt className="text-ink-soft">{t('connector.protocol')}</dt>
                  <dd>{connection.protocol}</dd>
                </div>
              )}
              <div>
                <dt className="text-ink-soft">{t('connector.configPath')}</dt>
                <dd className="break-all">{connection.configPath}</dd>
              </div>
            </dl>
          </details>
          {confirmUndo ?
            <div className="space-y-3">
              <p>{t('connector.confirmUndo', { harness: name })}</p>
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
            {t(
              connection.credentialMode === 'config' ?
                'connector.plaintextRestartNotice'
              : 'connector.restartNotice',
              { harness: name },
            )}
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
