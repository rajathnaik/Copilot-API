import type {
  AvailableModel,
  Role,
  Source,
  SourceInput,
  SourceUpdate,
} from '@modelbridge/runtime/contracts'
import type { CopilotLogin, CopilotQuota } from '@modelbridge/runtime/copilot'
import type {
  CodexConfigurationStatus,
  CodexPreview,
} from '@modelbridge/runtime/codex'
import type { UsageRange, UsageSummary } from '@modelbridge/runtime/usage'
import type {
  AppConfigurationPreview,
  AppConfigurationStatus,
  ConfigurableApp,
} from '@modelbridge/runtime/apps'
import type {
  ClientLimitStatus,
  PremiumLimits,
} from '@modelbridge/runtime/limits'
import type { CodexInstallation } from '../electron/codex-discovery'
import type { UpdateState } from '../electron/updates'
import type { TunnelHealth } from '../electron/tunnel-watchdog'
import type { TunnelHealthSettings } from '@modelbridge/runtime/contracts'

export type { UpdateState, TunnelHealth }

export interface DataLocationStatus {
  path: string
  defaultPath: string
  // False in development builds or when started with --user-data-dir.
  movable: boolean
  // The previous folder, after a move in this session.
  movedFrom: string | null
}

export interface AppStatus {
  version: string
  update: UpdateState
  data: DataLocationStatus
  role: Role | null
  // Name reported to remote hosts; defaults to this computer's name.
  clientName: string
  defaultClientName: string
  localUrl: string
  sources: Source[]
  // Result of the last connection check for each source, by source ID.
  sourceHealth: Record<string, SourceHealth>
  models: AvailableModel[]
  sharing: boolean
  remoteUrl: string | null
  transportError: string | null
  login: { url: string; code: string } | null
  tunnelUser: { name: string; provider: string } | null
  tunnelUserChecking: boolean
  tunnelSigningIn: boolean
  tunnelAccountError: string | null
  tunnelHealth: TunnelHealth & {
    // Sharing is wanted but the tunnel is down and waiting to reconnect.
    pending: boolean
  }
  copilotLogin: CopilotLogin | null
  copilotError: string | null
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export interface SourceHealth {
  ok: boolean
  checkedAt: string
  message: string | null
}

export interface CopilotQuotaStatus {
  sourceId: string
  label: string
  quota: CopilotQuota | null
  error: string | null
}

export interface UsageReport {
  summary: UsageSummary
  error: string | null
  limits: PremiumLimits
  // This month's reported usage and warn-only limit state for each remote client.
  clients: ClientLimitStatus[]
}

export interface PlaygroundRequest {
  id: string
  path:
    | '/health'
    | '/v1/models'
    | '/v1/responses'
    | '/v1/chat/completions'
    | '/v1/messages'
  // Sent as a POST when present.
  body?: Record<string, unknown>
}

export interface PlaygroundResult {
  status: number
  contentType: string
  durationMs: number
  // Time until the first bytes of the reply arrived.
  firstChunkMs: number | null
  cancelled: boolean
}

export interface ModelBridgeAPI {
  status(): Promise<Result<AppStatus>>
  setRole(role: Role): Promise<Result<AppStatus>>
  setClientName(name: string | null): Promise<Result<AppStatus>>
  usage(range: UsageRange): Promise<Result<UsageReport>>
  setPremiumLimits(limits: PremiumLimits): Promise<Result<PremiumLimits>>
  clearUsage(): Promise<Result<UsageSummary>>
  copilotQuota(refresh: boolean): Promise<Result<CopilotQuotaStatus[]>>
  addSource(input: SourceInput): Promise<Result<AppStatus>>
  updateSource(input: SourceUpdate): Promise<Result<AppStatus>>
  removeSource(sourceId: string): Promise<Result<AppStatus>>
  shareSource(
    sourceId: string,
    shared: boolean,
    sharedModelIds?: string[] | null,
  ): Promise<Result<AppStatus>>
  setWebSearchModel(
    sourceId: string,
    modelId: string | null,
  ): Promise<Result<AppStatus>>
  localKey(): Promise<Result<string>>
  remoteKey(): Promise<Result<string>>
  loginTunnel(provider: 'github' | 'microsoft'): Promise<Result<AppStatus>>
  checkTunnelLogin(): Promise<Result<AppStatus>>
  startSharing(): Promise<Result<AppStatus>>
  stopSharing(): Promise<Result<AppStatus>>
  // Asks Microsoft whether this host is attached and reconnects if not.
  checkTunnel(): Promise<Result<AppStatus>>
  setTunnelHealth(settings: TunnelHealthSettings): Promise<Result<AppStatus>>
  loginCopilot(label: string, shared: boolean): Promise<Result<AppStatus>>
  cancelCopilotLogin(): Promise<Result<AppStatus>>
  refreshSource(sourceId: string): Promise<Result<AppStatus>>
  codexStatus(): Promise<Result<CodexConfigurationStatus>>
  discoverCodex(): Promise<
    Result<{ installations: CodexInstallation[]; warnings: string[] }>
  >
  selectCodex(): Promise<Result<CodexInstallation>>
  previewCodex(label: string, modelId: string): Promise<Result<CodexPreview>>
  previewCodexRevision(id: string): Promise<Result<CodexPreview>>
  previewCodexRestore(): Promise<Result<CodexPreview>>
  applyCodex(id: string): Promise<Result<CodexConfigurationStatus>>
  reconcileCodex(): Promise<Result<CodexConfigurationStatus>>
  openLogin(url: string): Promise<Result<void>>
  // Reply text arrives through onPlaygroundChunk while this is pending.
  playgroundSend(request: PlaygroundRequest): Promise<Result<PlaygroundResult>>
  playgroundCancel(id: string): Promise<Result<void>>
  onPlaygroundChunk(
    listener: (chunk: { id: string; text: string }) => void,
  ): () => void
  copyText(text: string): Promise<Result<void>>
  copyKey(remote: boolean): Promise<Result<void>>
  appConfigStatus(app: ConfigurableApp): Promise<Result<AppConfigurationStatus>>
  previewAppConfig(
    app: ConfigurableApp,
    modelId: string,
  ): Promise<Result<AppConfigurationPreview>>
  previewAppRestore(
    app: ConfigurableApp,
  ): Promise<Result<AppConfigurationPreview>>
  applyAppConfig(id: string): Promise<Result<AppConfigurationStatus>>
  checkForUpdate(): Promise<Result<AppStatus>>
  // Downloads, verifies, then restarts ModelBridge into the installer.
  installUpdate(): Promise<Result<AppStatus>>
  openRelease(): Promise<Result<void>>
  // Resolves to null when the folder picker is cancelled.
  chooseDataFolder(): Promise<Result<string | null>>
  moveDataFolder(target: string): Promise<Result<AppStatus>>
  openDataFolder(): Promise<Result<void>>
}

declare global {
  interface Window {
    modelbridge: ModelBridgeAPI
  }
}
