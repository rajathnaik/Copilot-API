import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import { useLanguage } from '../contexts/LanguageContext'
import { SNIPPET_API_KEY_PLACEHOLDER } from '../lib/playground'
import { buildClientSetups, type ClientSetupId } from '../lib/remote-access'
import type {
  DesktopSettings,
  TunnelLoginProvider,
  TunnelStatus,
} from '../types/ipc'

const DEVTUNNEL_INSTALL_GUIDE_URL =
  'https://learn.microsoft.com/azure/developer/dev-tunnels/get-started#install'

const buttonClass =
  'px-3 py-1.5 border border-line rounded-md text-[13px] text-ink-soft hover:bg-sunken disabled:opacity-50'
const primaryButtonClass =
  'px-3 py-1.5 rounded-md text-[13px] font-medium text-white bg-accent-strong hover:bg-accent-strong/90 dark:bg-blue-500 dark:hover:bg-blue-400 disabled:opacity-50'

function StepCard({
  done,
  index,
  title,
  children,
}: {
  done: boolean
  index: number
  title: string
  children: ReactNode
}) {
  return (
    <div className="flex gap-3">
      <div
        className={`mt-0.5 w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-[12px] font-semibold ${
          done ?
            'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
          : 'bg-sunken text-ink-faint border border-line'
        }`}
      >
        {done ? '✓' : index}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-ink mb-1">{title}</div>
        {children}
      </div>
    </div>
  )
}

export default function RemoteAccessPage() {
  const { t } = useLanguage()
  const [status, setStatus] = useState<TunnelStatus | null>(null)
  const [settings, setSettings] = useState<DesktopSettings | null>(null)
  const [apiKeyCount, setApiKeyCount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState('')
  const [clientTab, setClientTab] = useState<ClientSetupId>('curl')
  const [connectorDownloadError, setConnectorDownloadError] = useState('')

  const refresh = useCallback(async () => {
    const [tunnelStatus, keys, desktopSettings] = await Promise.all([
      window.electronAPI.tunnelGetStatus(),
      window.electronAPI.getServerKeys().catch(() => null),
      window.electronAPI.getSettings(),
    ])
    setStatus(tunnelStatus)
    setApiKeyCount(keys ? keys.apiKeys.length : null)
    setSettings(desktopSettings)
  }, [])

  useEffect(() => {
    void refresh()
    return window.electronAPI.onTunnelStatus(setStatus)
  }, [refresh])

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  const copy = (key: string, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key)
      setTimeout(
        () => setCopied((current) => (current === key ? '' : current)),
        1500,
      )
    })
  }

  const handleAutoStartChange = async (enabled: boolean) => {
    if (!settings) return
    const next = { ...settings, autoStartTunnel: enabled }
    setSettings(next)
    await window.electronAPI.saveSettings(next)
  }

  const handleLogin = (provider: TunnelLoginProvider) =>
    run(() => window.electronAPI.tunnelLogin(provider))

  const downloadConnector = async () => {
    setConnectorDownloadError('')
    try {
      await window.electronAPI.openUrl(
        'https://github.com/caozhiyuan/copilot-api/releases',
      )
    } catch (error) {
      console.error('Could not open connector releases page', error)
      setConnectorDownloadError(t('connector.downloadError'))
    }
  }

  const clientSetups = useMemo(
    () => (status?.url ? buildClientSetups(status.url) : []),
    [status?.url],
  )
  const activeSetup =
    clientSetups.find((setup) => setup.id === clientTab) ?? clientSetups[0]

  if (!status) {
    return (
      <div className="p-4 text-[13px] text-ink-faint">
        {t('dashboard.loading')}
      </div>
    )
  }

  const running = status.state === 'running'
  const starting = status.state === 'starting'
  const canStart =
    status.cliInstalled && Boolean(status.user) && !starting && !running
  const stateLabel = {
    running: t('remoteAccess.stateRunning'),
    stopped: t('remoteAccess.stateStopped'),
    starting: t('remoteAccess.stateStarting'),
    error: t('remoteAccess.stateError'),
  }[status.state]
  const stateTone = {
    running: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    stopped: 'bg-sunken text-ink-faint',
    starting: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    error: 'bg-red-500/15 text-red-600 dark:text-red-400',
  }[status.state]

  return (
    <div className="p-4 h-full flex gap-4 min-h-0">
      {/* Setup steps */}
      <aside className="w-[380px] shrink-0 bg-surface border border-line rounded-xl p-4 flex flex-col gap-4 overflow-y-auto">
        <div className="flex items-start justify-between gap-2">
          <p className="text-[13px] text-ink-soft">
            {t('remoteAccess.description')}
          </p>
          <button
            type="button"
            className={buttonClass}
            onClick={() => void run(refresh)}
            disabled={busy}
          >
            {t('remoteAccess.refresh')}
          </button>
        </div>

        <StepCard
          done={status.cliInstalled}
          index={1}
          title={t('remoteAccess.stepCli')}
        >
          {status.cliInstalled ?
            <p className="text-[13px] text-ink-soft">
              {t('remoteAccess.cliInstalled')}
            </p>
          : <div className="flex flex-col gap-2">
              <p className="text-[13px] text-ink-faint">
                {status.installSupported ?
                  t('remoteAccess.cliMissing')
                : t('remoteAccess.installManual')}
              </p>
              <div className="flex gap-2">
                {status.installSupported && (
                  <button
                    type="button"
                    className={primaryButtonClass}
                    disabled={status.installing}
                    onClick={() =>
                      void run(() => window.electronAPI.tunnelInstall())
                    }
                  >
                    {status.installing ?
                      t('remoteAccess.installing')
                    : t('remoteAccess.install')}
                  </button>
                )}
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() =>
                    void window.electronAPI.openUrl(DEVTUNNEL_INSTALL_GUIDE_URL)
                  }
                >
                  {t('remoteAccess.installGuide')}
                </button>
              </div>
            </div>
          }
        </StepCard>

        <StepCard
          done={Boolean(status.user)}
          index={2}
          title={t('remoteAccess.stepSignIn')}
        >
          {status.user ?
            <div className="flex items-center justify-between gap-2">
              <p className="text-[13px] text-ink-soft truncate">
                {t('remoteAccess.signedInAs', {
                  name: status.user.name,
                  provider: status.user.provider,
                })}
              </p>
              <button
                type="button"
                className={buttonClass}
                disabled={busy || starting}
                onClick={() =>
                  void run(() => window.electronAPI.tunnelLogout())
                }
              >
                {t('remoteAccess.signOut')}
              </button>
            </div>
          : status.loggingIn ?
            <div className="flex flex-col gap-2">
              {status.login ?
                <>
                  <p className="text-[13px] text-ink-soft">
                    {t('remoteAccess.deviceCodeHint')}
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="px-2 py-1 bg-sunken border border-line rounded text-[15px] font-semibold tracking-wider text-ink">
                      {status.login.code}
                    </code>
                    <button
                      type="button"
                      className={buttonClass}
                      onClick={() => copy('code', status.login?.code ?? '')}
                    >
                      {copied === 'code' ?
                        t('remoteAccess.copied')
                      : t('remoteAccess.copy')}
                    </button>
                    <button
                      type="button"
                      className={buttonClass}
                      onClick={() =>
                        void window.electronAPI.openUrl(status.login?.url ?? '')
                      }
                    >
                      {t('remoteAccess.openPage')}
                    </button>
                  </div>
                </>
              : <p className="text-[13px] text-ink-faint">
                  {t('remoteAccess.waitingForLogin')}
                </p>
              }
              <button
                type="button"
                className={`${buttonClass} self-start`}
                onClick={() => void window.electronAPI.tunnelCancelLogin()}
              >
                {t('remoteAccess.cancel')}
              </button>
            </div>
          : <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={primaryButtonClass}
                disabled={!status.cliInstalled || busy}
                onClick={() => void handleLogin('github')}
              >
                {t('remoteAccess.signInGithub')}
              </button>
              <button
                type="button"
                className={buttonClass}
                disabled={!status.cliInstalled || busy}
                onClick={() => void handleLogin('microsoft')}
              >
                {t('remoteAccess.signInMicrosoft')}
              </button>
            </div>
          }
        </StepCard>

        <StepCard
          done={Boolean(apiKeyCount)}
          index={3}
          title={t('remoteAccess.stepKey')}
        >
          <p
            className={`text-[13px] ${
              apiKeyCount ? 'text-ink-soft' : (
                'text-amber-600 dark:text-amber-400'
              )
            }`}
          >
            {apiKeyCount ?
              t('remoteAccess.keyConfigured', { n: apiKeyCount })
            : t('remoteAccess.keyMissing')}
          </p>
        </StepCard>

        <StepCard done={running} index={4} title={t('remoteAccess.stepTunnel')}>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <span
                className={`px-2 py-0.5 rounded-full text-[12px] font-medium ${stateTone}`}
              >
                {stateLabel}
              </span>
              {running || starting ?
                <button
                  type="button"
                  className={buttonClass}
                  disabled={busy}
                  onClick={() =>
                    void run(() => window.electronAPI.tunnelStop())
                  }
                >
                  {t('remoteAccess.stop')}
                </button>
              : <button
                  type="button"
                  className={primaryButtonClass}
                  disabled={!canStart || busy}
                  onClick={() =>
                    void run(() => window.electronAPI.tunnelStart())
                  }
                >
                  {t('remoteAccess.start')}
                </button>
              }
            </div>

            {status.error && (
              <p className="px-2.5 py-1.5 bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-md text-[12px] text-red-600 dark:text-red-400 break-words">
                {status.error}
              </p>
            )}

            {status.url && (
              <div className="flex flex-col gap-1.5">
                <span className="text-[12px] font-semibold text-ink-faint uppercase tracking-wide">
                  {t('remoteAccess.publicUrl')}
                </span>
                <code
                  className={`px-2 py-1.5 bg-sunken border border-line rounded text-[12px] break-all ${
                    running ? 'text-ink' : 'text-ink-faint'
                  }`}
                >
                  {status.url}
                </code>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => copy('url', status.url ?? '')}
                  >
                    {copied === 'url' ?
                      t('remoteAccess.copied')
                    : t('remoteAccess.copy')}
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={!running}
                    onClick={() =>
                      void window.electronAPI.openUrl(status.url ?? '')
                    }
                  >
                    {t('remoteAccess.open')}
                  </button>
                </div>
                <p className="text-[12px] text-ink-faint">
                  {t('remoteAccess.publicUrlHint')}
                </p>
              </div>
            )}

            <label className="flex items-center gap-2 text-[13px] text-ink-soft cursor-pointer">
              <input
                type="checkbox"
                checked={settings?.autoStartTunnel ?? false}
                disabled={!settings}
                onChange={(event) =>
                  void handleAutoStartChange(event.target.checked)
                }
              />
              {t('remoteAccess.autoStart')}
            </label>
          </div>
        </StepCard>
      </aside>

      {/* Client setup and activity */}
      <section className="flex-1 min-w-0 flex flex-col gap-4 min-h-0">
        <div className="bg-surface border border-line rounded-xl p-4 flex flex-col gap-3 min-h-0 flex-1">
          <div className="text-[14px] font-semibold text-ink">
            {t('remoteAccess.clientsTitle')}
          </div>
          <div className="space-y-2 rounded-md border border-line bg-sunken p-3">
            <p className="text-[12px] text-ink-soft">
              {t('connector.consumerSetup')}
            </p>
            <button
              type="button"
              className={buttonClass}
              onClick={downloadConnector}
            >
              {t('connector.download')}
            </button>
            {connectorDownloadError && (
              <p
                role="alert"
                className="text-[12px] text-red-600 dark:text-red-400"
              >
                {connectorDownloadError}
              </p>
            )}
          </div>
          {activeSetup ?
            <>
              <div className="flex flex-wrap gap-1.5">
                {clientSetups.map((setup) => (
                  <button
                    key={setup.id}
                    type="button"
                    onClick={() => setClientTab(setup.id)}
                    className={`px-2.5 py-1 rounded-md text-[12px] border ${
                      setup.id === activeSetup.id ?
                        'border-accent text-ink font-medium'
                      : 'border-line text-ink-faint hover:text-ink-soft'
                    }`}
                  >
                    {setup.title}
                  </button>
                ))}
              </div>
              <div className="relative flex-1 min-h-0">
                <pre className="h-full overflow-auto p-3 bg-sunken border border-line rounded-md text-[12px] leading-relaxed text-ink whitespace-pre">
                  {activeSetup.code}
                </pre>
                <button
                  type="button"
                  className={`${buttonClass} absolute top-2 right-2 bg-surface`}
                  onClick={() => copy('snippet', activeSetup.code)}
                >
                  {copied === 'snippet' ?
                    t('remoteAccess.copied')
                  : t('remoteAccess.copy')}
                </button>
              </div>
              <p className="text-[12px] text-ink-faint">
                {t('remoteAccess.clientsHint', {
                  placeholder: SNIPPET_API_KEY_PLACEHOLDER,
                })}
              </p>
            </>
          : <p className="text-[13px] text-ink-faint">
              {t('remoteAccess.clientsEmpty')}
            </p>
          }
        </div>

        <div className="bg-black rounded-xl p-3 h-[180px] shrink-0 flex flex-col min-h-0">
          <div className="text-[12px] font-semibold text-gray-400 mb-1.5">
            {t('remoteAccess.activity')}
          </div>
          <div className="flex-1 overflow-y-auto font-mono text-[12px] text-gray-300 leading-relaxed">
            {status.logs.map((line, index) => (
              <div key={`${index}-${line}`} className="break-all">
                {line}
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}
