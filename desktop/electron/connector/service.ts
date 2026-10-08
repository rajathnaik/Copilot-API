import type {
  CodexInstallation,
  ConnectorConnection,
  ConnectorInput,
} from '../../src/types/connector'
import {
  configureCodex,
  hasConnectorProvider,
  managedConfigFingerprint,
  restoreCodex,
} from './config'
import {
  verifyCredentialHelper,
  verifyNativeCodex,
  type CommandRunner,
} from './codex'
import {
  discoverGateway,
  validateApiKey,
  verifyStreamingTools,
  type ConnectorFetch,
} from './gateway'
import { ConnectorStore, type ConnectionState } from './store'

export interface ConnectorDependencies {
  installation(): Promise<CodexInstallation | null>
  helperCommand: string
  helperArgs: string[]
  runner?: CommandRunner
  fetcher?: ConnectorFetch
}

export class ConnectorService {
  constructor(
    readonly store: ConnectorStore,
    private readonly dependencies: ConnectorDependencies,
  ) {}

  private async installation(): Promise<CodexInstallation> {
    const installation = await this.dependencies.installation()
    if (!installation) {
      throw new Error(
        'Codex was not detected. Install Codex CLI 0.160.0 or newer, or select the Codex executable bundled with your desktop app.',
      )
    }
    return installation
  }

  async discover(input: ConnectorInput) {
    const installation = await this.installation()
    const { catalog: _catalog, ...discovery } = await discoverGateway(
      input,
      installation.version,
      this.dependencies.fetcher,
    )
    return discovery
  }

  async connect(input: ConnectorInput): Promise<ConnectorConnection> {
    return this.store.exclusive(async () => {
      const installation = await this.installation()
      const apiKey = validateApiKey(input.apiKey)
      const encryptedKey = this.store.encryptKey(apiKey)
      const state = this.store.state()
      const original = this.store.read('config')
      if (state) {
        if (managedConfigFingerprint(original ?? '') !== state.fingerprint) {
          throw new Error(
            'Connector-managed Codex settings were edited outside the connector. Restore those settings before reconnecting or undoing.',
          )
        }
      } else if (hasConnectorProvider(original ?? '')) {
        throw new Error(
          'A provider named copilot_api_connector already exists without connector ownership. Rename it before connecting.',
        )
      }
      const discovery = await discoverGateway(
        input,
        installation.version,
        this.dependencies.fetcher,
      )
      const model =
        input.model ?? state?.connection.model ?? discovery.defaultModel
      if (!discovery.models.some((candidate) => candidate.id === model)) {
        throw new Error(
          'The selected model is no longer available in discovery. Discover models and select another model explicitly.',
        )
      }
      await verifyStreamingTools(
        discovery,
        model,
        apiKey,
        this.dependencies.fetcher,
      )
      if (this.store.read('config') !== original) {
        throw new Error(
          'Codex configuration changed during discovery. Close its editor and retry.',
        )
      }
      const options = {
        baseUrl: discovery.baseUrl,
        model,
        catalogPath:
          discovery.catalogMode === 'local' ? this.store.files.catalog : null,
        helperCommand: this.dependencies.helperCommand,
        helperArgs: this.dependencies.helperArgs,
      }
      const configured = configureCodex(original ?? '', options)
      const connection: ConnectorConnection = {
        harness: 'codex',
        baseUrl: discovery.baseUrl,
        model,
        modelCount: discovery.models.length,
        catalogMode: discovery.catalogMode,
        verifiedAt: new Date().toISOString(),
        configPath: this.store.files.config,
      }
      const nextState: ConnectionState = {
        version: 1,
        originalConfig: state ? state.originalConfig : original,
        fingerprint: managedConfigFingerprint(configured),
        connection,
      }
      await this.store
        .transaction(
          {
            config: configured,
            catalog:
              discovery.catalogMode === 'local' ? discovery.catalog : null,
            credential: encryptedKey,
            state: JSON.stringify(nextState),
          },
          async () => {
            await verifyCredentialHelper(
              this.dependencies.helperCommand,
              this.dependencies.helperArgs,
              apiKey,
              this.dependencies.runner,
            )
            // Isolate the smoke test from user MCP servers, plugins, and project
            // settings while exercising the exact installed provider and helper.
            await verifyNativeCodex(
              installation,
              configureCodex('', options),
              this.dependencies.runner,
            )
            connection.verifiedAt = new Date().toISOString()
            return JSON.stringify(nextState)
          },
        )
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : 'Connector setup failed.'
          const key = input.apiKey.trim()
          throw new Error(key ? message.split(key).join('[redacted]') : message)
        })
      return connection
    })
  }

  async refresh(): Promise<ConnectorConnection> {
    const state = this.store.state()
    if (!state) throw new Error('There is no saved connection to refresh.')
    return this.connect({
      url: state.connection.baseUrl,
      apiKey: this.store.key(),
      model: state.connection.model,
    })
  }

  async undo(): Promise<void> {
    return this.store.exclusive(async () => {
      const state = this.store.state()
      if (!state) throw new Error('There is no saved connection to undo.')
      const current = this.store.read('config') ?? ''
      if (managedConfigFingerprint(current) !== state.fingerprint) {
        throw new Error(
          'Connector-managed settings were edited externally. Undo will not overwrite them; restore those settings first.',
        )
      }
      const restored = restoreCodex(current, state.originalConfig ?? '')
      await this.store.transaction(
        {
          config:
            state.originalConfig === null && !restored.trim() ? null : restored,
          catalog: null,
          credential: null,
          state: null,
        },
        () => Promise.resolve(),
      )
    })
  }
}
