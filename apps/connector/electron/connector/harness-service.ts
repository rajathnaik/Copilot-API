import type {
  ConnectorConnection,
  ConnectorInput,
  HarnessInstallation,
  ConnectorHarness,
} from '../../src/types/connector'
import { runCommand, verifyCredentialHelper, type CommandRunner } from './codex'
import {
  discoverStandardGateway,
  validateApiKey,
  normalizeGatewayUrl,
  verifyStandardStreamingTools,
  type ConnectorFetch,
} from './gateway'
import {
  configureHarness,
  harnessFingerprint,
  HARNESS_NAMES,
  HARNESS_PROTOCOLS,
  hasHarnessProvider,
  OPENCLAW_SECRET_ID,
  PROVIDER_ID,
  restoreHarness,
  type AdditionalHarness,
} from './harness'
import { ConnectorStore, type ConnectionState } from './store'

interface HarnessDependencies {
  installation(): Promise<HarnessInstallation | null>
  helperCommand: string
  helperArgs: string[]
  runner?: CommandRunner
  fetcher?: ConnectorFetch
}

export function openClawSecretRequest(): string {
  return JSON.stringify({
    protocolVersion: 1,
    provider: PROVIDER_ID,
    ids: [OPENCLAW_SECRET_ID],
  })
}

export async function resolveSharedInput(
  input: ConnectorInput,
  storeFor: (harness: ConnectorHarness) => ConnectorStore,
): Promise<ConnectorInput> {
  if (input.copyFrom === undefined) return input
  if (input.apiKey.trim())
    throw new Error('Choose a saved gateway or enter a key, not both.')
  const source = storeFor(input.copyFrom)
  return source.exclusive(() => {
    const connection = source.state()?.connection
    if (!connection)
      throw new Error('The selected source has no saved gateway connection.')
    if (normalizeGatewayUrl(input.url) !== connection.baseUrl)
      throw new Error(
        'A saved gateway key cannot be copied to a different URL. Enter its key explicitly.',
      )
    return Promise.resolve({ ...input, apiKey: source.key() })
  })
}

export class HarnessService {
  constructor(
    readonly harness: AdditionalHarness,
    readonly store: ConnectorStore,
    private readonly dependencies: HarnessDependencies,
  ) {}

  private protocol() {
    const protocol = HARNESS_PROTOCOLS[this.harness]
    if (protocol === 'responses')
      throw new Error('Invalid additional harness protocol.')
    return protocol
  }

  private async installation(): Promise<HarnessInstallation> {
    const result = await this.dependencies.installation()
    if (!result)
      throw new Error(
        `${HARNESS_NAMES[this.harness]} was not detected. Install its current version and retry detection.`,
      )
    return result
  }

  async discover(input: ConnectorInput) {
    await this.installation()
    const { catalog: _catalog, ...discovery } = await discoverStandardGateway(
      input,
      this.protocol(),
      this.dependencies.fetcher,
    )
    return discovery
  }

  async connect(input: ConnectorInput): Promise<ConnectorConnection> {
    const key = validateApiKey(input.apiKey)
    try {
      return await this.store.exclusive(async () => {
        const installation = await this.installation()
        const credential = this.store.encryptKey(key)
        const state = this.store.state()
        if (this.harness === 'opencode' && input.allowPlaintext !== true)
          throw new Error(
            'OpenCode requires explicit permission to save a readable gateway key in its configuration.',
          )
        const original = this.store.read('config')
        if (
          state
          && harnessFingerprint(this.harness, original ?? '')
            !== state.fingerprint
        )
          throw new Error(
            'Connector-managed settings were edited externally. Restore them before reconnecting or undoing.',
          )
        if (!state && hasHarnessProvider(this.harness, original ?? ''))
          throw new Error(
            'A connector provider already exists without ownership. Rename it before connecting.',
          )
        const discovery = await discoverStandardGateway(
          input,
          this.protocol(),
          this.dependencies.fetcher,
        )
        const model =
          input.model ?? state?.connection.model ?? discovery.defaultModel
        if (!discovery.models.some((candidate) => candidate.id === model))
          throw new Error(
            'The selected model is no longer available. Discover models and select another explicitly.',
          )
        await verifyStandardStreamingTools(
          discovery,
          this.protocol(),
          model,
          key,
          this.dependencies.fetcher,
        )
        if (this.store.read('config') !== original)
          throw new Error(
            'Harness configuration changed during discovery. Close its editor and retry.',
          )
        const configured = configureHarness(this.harness, original ?? '', {
          baseUrl: discovery.baseUrl,
          model,
          models: discovery.models,
          apiKey: key,
          helperCommand: this.dependencies.helperCommand,
          helperArgs: this.dependencies.helperArgs,
        })
        const connection: ConnectorConnection = {
          harness: this.harness,
          baseUrl: discovery.baseUrl,
          model,
          modelCount: discovery.models.length,
          catalogMode: 'configured',
          verifiedAt: new Date().toISOString(),
          configPath: this.store.files.config,
          protocol: this.protocol(),
          credentialMode: this.harness === 'opencode' ? 'config' : 'helper',
        }
        const next: ConnectionState = {
          version: 1,
          connection,
          originalConfig: state ? state.originalConfig : original,
          fingerprint: harnessFingerprint(this.harness, configured),
        }
        await this.store.transaction(
          {
            config: configured,
            catalog: discovery.catalog,
            credential,
            state: JSON.stringify(next),
          },
          async () => {
            const runner = this.dependencies.runner ?? runCommand
            if (this.harness === 'openclaw') {
              const result = await runner(
                this.dependencies.helperCommand,
                this.dependencies.helperArgs,
                {
                  timeout: 30_000,
                  stdin: openClawSecretRequest(),
                },
              )
              let value: unknown
              try {
                value = JSON.parse(result.stdout)
              } catch {
                throw new Error(
                  'The OpenClaw credential helper returned invalid JSON.',
                )
              }
              if (typeof value !== 'string' || value !== key)
                throw new Error(
                  'The OpenClaw credential helper did not return the expected single-ID secret.',
                )
            } else if (this.harness !== 'opencode') {
              await verifyCredentialHelper(
                this.dependencies.helperCommand,
                this.dependencies.helperArgs,
                key,
                runner,
              )
            }
            if (this.harness === 'hermes' || this.harness === 'openclaw') {
              try {
                await runner(
                  installation.executable,
                  [
                    ...(installation.args ?? []),
                    'config',
                    ...(this.harness === 'hermes' ?
                      ['check']
                    : ['validate', '--json']),
                  ],
                  {
                    timeout: 30_000,
                    env:
                      this.harness === 'hermes' ?
                        {
                          HERMES_HOME: this.store.files.config.slice(
                            0,
                            -'config.yaml'.length,
                          ),
                        }
                      : { OPENCLAW_CONFIG_PATH: this.store.files.config },
                  },
                )
              } catch (error) {
                throw new Error(
                  `The installed ${HARNESS_NAMES[this.harness]} could not validate this configuration. Update it or run its config check manually; setup was rolled back.`,
                  { cause: error },
                )
              }
            }
            return JSON.stringify(next)
          },
        )
        return connection
      })
    } catch (error) {
      throw new Error(
        (error instanceof Error ? error.message : 'Harness setup failed.')
          .split(key)
          .join('[redacted]'),
      )
    }
  }

  async refresh(): Promise<ConnectorConnection> {
    const state = this.store.state()
    if (!state) throw new Error('There is no saved connection to refresh.')
    return this.connect({
      url: state.connection.baseUrl,
      apiKey: this.store.key(),
      model: state.connection.model,
      allowPlaintext: state.connection.credentialMode === 'config',
    })
  }

  async undo(): Promise<void> {
    await this.store.exclusive(async () => {
      const state = this.store.state()
      if (!state) throw new Error('There is no saved connection to undo.')
      const current = this.store.read('config') ?? ''
      if (harnessFingerprint(this.harness, current) !== state.fingerprint)
        throw new Error(
          'Connector-managed settings were edited externally. Undo will not overwrite them.',
        )
      const restored = restoreHarness(
        this.harness,
        current,
        state.originalConfig ?? '',
      )
      await this.store.transaction(
        {
          config:
            state.originalConfig === null && restored.empty ?
              null
            : restored.text,
          catalog: null,
          credential: null,
          state: null,
        },
        async () => {},
      )
    })
  }
}
