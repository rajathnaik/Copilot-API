import type { AppStatus } from './types'
import { failure, plural } from './format'
import { KeyReveal, type Revealed } from './KeyReveal'
import { sharedModelIds, type Run } from './shared'
import { SourceSharing } from './SourceSharing'

const label = 'My Copilot subscription'

function Step({ done, children }: { done: boolean; children: string }) {
  return (
    <li className={done ? 'done' : undefined}>
      <span aria-hidden="true">{done ? '✓' : '○'}</span> {children}
      <span className="sr-only">{done ? ' (done)' : ' (to do)'}</span>
    </li>
  )
}

export function HostSetup({
  status,
  busy,
  run,
  onError,
  revealed,
  onReveal,
  onHide,
  onReviewModels,
}: {
  status: AppStatus
  busy: boolean
  run: Run
  onError: (message: string) => void
  revealed: Revealed | null
  onReveal: (remote: boolean) => void
  onHide: () => void
  onReviewModels: () => void
}) {
  const copilotLogin = status.copilotLogin
  const copilotSources = status.sources.filter(
    (source) => source.kind === 'copilot',
  )
  const shared = sharedModelIds(status)
  const tunnelReady = !!status.tunnelUser && !status.tunnelAccountError
  const open = (url: string, fallback: string) =>
    void window.modelbridge
      .openLogin(url)
      .then((result) => {
        if (!result.ok) onError(result.error)
      })
      .catch((error: unknown) => onError(failure(error, fallback)))
  return (
    <>
      <ol className="steps" aria-label="Host setup progress">
        <Step done={copilotSources.length > 0}>Copilot signed in</Step>
        <Step done={tunnelReady}>Dev Tunnels signed in</Step>
        <Step done={status.sharing}>Sharing remotely</Step>
      </ol>
      <section>
        <h2>1. Sign in to GitHub Copilot</h2>
        <p className="muted">
          ModelBridge refreshes Copilot tokens, discovers your models and
          forwards requests directly, following the original gateway.
        </p>
        {copilotSources.length > 0 && (
          <p role="status">
            Signed in to Copilot:{' '}
            {copilotSources
              .map(
                (source) => `${source.label} (${source.models.length} models)`,
              )
              .join(', ')}
          </p>
        )}
        <div className="actions">
          <button
            className="primary"
            disabled={busy || !!copilotLogin || copilotSources.length > 0}
            onClick={() =>
              void run(() => window.modelbridge.loginCopilot(label, true))
            }
          >
            {copilotLogin ?
              'Waiting for GitHub approval...'
            : copilotSources.length ?
              'Signed in'
            : 'Sign in and discover models'}
          </button>
          {copilotSources.length > 0 && (
            <button
              disabled={busy || !!copilotLogin}
              onClick={() =>
                void run(() => window.modelbridge.loginCopilot(label, true))
              }
            >
              Sign in again
            </button>
          )}
          {copilotLogin && (
            <button
              disabled={busy}
              onClick={() =>
                void run(() => window.modelbridge.cancelCopilotLogin())
              }
            >
              Cancel sign-in
            </button>
          )}
        </div>
        {copilotLogin && (
          <div className="login">
            <p role="status">
              Enter <strong>{copilotLogin.code}</strong> at{' '}
              <code>{copilotLogin.url}</code>. Discovery continues
              automatically.
            </p>
            <button
              onClick={() =>
                open(copilotLogin.url, 'Could not open GitHub sign-in.')
              }
            >
              Open GitHub sign-in
            </button>
          </div>
        )}
      </section>
      <section>
        <h2>2. Enable remote access</h2>
        <p className="muted">
          Microsoft Dev Tunnels provides the HTTPS URL. Sign in to Dev Tunnels
          once on this host, with the GitHub account you use for Copilot or a
          Microsoft account, not both. This authorizes the tunnel, separately
          from access to your Copilot models. Client machines never sign in;
          they only need the URL and the host access key. Hosting requires the
          separately installed Dev Tunnels CLI.
        </p>
        <div className="actions">
          <span>
            {plural(shared.size, 'model')} available to remote clients
          </span>
          <button onClick={onReviewModels}>Review all sources</button>
        </div>
        <p role="status">
          {status.tunnelSigningIn ?
            'Dev Tunnels: waiting for browser approval...'
          : status.tunnelUserChecking ?
            'Dev Tunnels: checking sign-in...'
          : status.tunnelAccountError ?
            'Dev Tunnels: sign-in could not be confirmed.'
          : status.tunnelUser ?
            <>
              Dev Tunnels: signed in as{' '}
              <strong>{status.tunnelUser.name}</strong> using{' '}
              {status.tunnelUser.provider}.
            </>
          : 'Dev Tunnels: not signed in.'}
        </p>
        {status.tunnelAccountError && (
          <p role="alert" className="error">
            {status.tunnelAccountError}
          </p>
        )}
        <div className="actions">
          {status.tunnelSigningIn || status.tunnelUserChecking ?
            <button disabled>
              {status.tunnelSigningIn ?
                'Waiting for approval...'
              : 'Checking sign-in...'}
            </button>
          : tunnelReady ?
            <button disabled>Signed in</button>
          : <>
              <button
                className="primary"
                disabled={busy || status.sharing}
                onClick={() =>
                  void run(() => window.modelbridge.loginTunnel('github'))
                }
              >
                Sign in with GitHub
              </button>
              <button
                disabled={busy || status.sharing}
                onClick={() =>
                  void run(() => window.modelbridge.loginTunnel('microsoft'))
                }
              >
                Sign in with Microsoft
              </button>
            </>
          }
          <button
            disabled={busy || status.tunnelUserChecking}
            onClick={() =>
              void run(() => window.modelbridge.checkTunnelLogin())
            }
          >
            {status.tunnelSigningIn ?
              "I've signed in - check status"
            : 'Check sign-in status'}
          </button>
          <button
            className={status.tunnelUser ? 'primary' : undefined}
            disabled={
              busy
              || (!status.sharing
                && (status.tunnelSigningIn
                  || status.tunnelUserChecking
                  || !tunnelReady))
            }
            onClick={() =>
              void run(() =>
                status.sharing ?
                  window.modelbridge.stopSharing()
                : window.modelbridge.startSharing(),
              )
            }
          >
            {status.sharing ? 'Stop sharing' : 'Enable remote access'}
          </button>
        </div>
        {status.tunnelUser
          && !status.tunnelSigningIn
          && !status.tunnelUserChecking && (
            <details>
              <summary>Change Dev Tunnels account</summary>
              <p className="muted">
                Stop sharing before changing accounts. A different account might
                not own this installation&apos;s tunnel.
              </p>
              <div className="actions">
                <button
                  disabled={busy || status.sharing}
                  onClick={() =>
                    void run(() => window.modelbridge.loginTunnel('github'))
                  }
                >
                  Switch to a GitHub account
                </button>
                <button
                  disabled={busy || status.sharing}
                  onClick={() =>
                    void run(() => window.modelbridge.loginTunnel('microsoft'))
                  }
                >
                  Switch to a Microsoft account
                </button>
              </div>
            </details>
          )}
        {status.login && (
          <div className="login">
            <p role="status">
              Enter <strong>{status.login.code}</strong> at{' '}
              <code>{status.login.url}</code>. Status refreshes automatically
              after the CLI confirms sign-in. If it has not updated after
              browser approval, use &quot;I&apos;ve signed in - check
              status&quot;; this verifies the account with the CLI.
            </p>
            <button
              onClick={() => {
                const url = status.login?.url
                if (url) open(url, 'Could not open the sign-in page.')
              }}
            >
              Open sign-in page
            </button>
          </div>
        )}
      </section>
      {copilotSources.length > 0 && (
        <section className="model-access">
          <h2>3. Choose the models clients can use</h2>
          <p className="muted">
            Client machines can discover and call only the models allowed here,
            even if they know another model&apos;s ID. Choose &quot;Only
            selected models&quot; to pick them individually.
          </p>
          {copilotSources.map((source) => (
            <div className="source" key={source.id}>
              <label className="checkbox">
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={source.shared}
                  onChange={(event) =>
                    void run(() =>
                      window.modelbridge.shareSource(
                        source.id,
                        event.target.checked,
                      ),
                    )
                  }
                />
                Share {source.label} with client machines
              </label>
              <SourceSharing
                source={source}
                busy={busy}
                open
                onChange={(modelIds) =>
                  void run(() =>
                    window.modelbridge.shareSource(
                      source.id,
                      source.shared,
                      modelIds,
                    ),
                  )
                }
              />
            </div>
          ))}
        </section>
      )}
      {status.sharing && (
        <section>
          <h2>4. Give these to your client machine</h2>
          <dl className="pairs">
            <dt>Host URL</dt>
            <dd>
              <code>{status.remoteUrl ?? 'Waiting for the tunnel…'}</code>
            </dd>
            <dt>Access key</dt>
            <dd>
              <button disabled={busy} onClick={() => onReveal(true)}>
                Show host access key
              </button>
            </dd>
          </dl>
          <KeyReveal revealed={revealed} remote onHide={onHide} />
        </section>
      )}
    </>
  )
}
