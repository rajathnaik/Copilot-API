import type {
  AvailableModel,
  Role,
  Source,
  SourceInput,
} from '@modelbridge/runtime/contracts'
import type { CopilotLogin, CopilotQuota } from '@modelbridge/runtime/copilot'
import type {
  CodexConfigurationStatus,
  CodexPreview,
} from '@modelbridge/runtime/codex'
import type { UsageRange, UsageSummary } from '@modelbridge/runtime/usage'
import type {
  ClientLimitStatus,
  PremiumLimits,
} from '@modelbridge/runtime/limits'
import type { CodexInstallation } from '../electron/codex-discovery'

export interface AppStatus {
  version: string
  role: Role | null
  // Name reported to remote hosts; defaults to this computer's name.
  clientName: string
  defaultClientName: string
  localUrl: string
  sources: Source[]
  models: AvailableModel[]
  sharing: boolean
  remoteUrl: string | null
  transportError: string | null
  login: { url: string; code: string } | null
  tunnelUser: { name: string; provider: string } | null
  tunnelUserChecking: boolean
  tunnelSigningIn: boolean
  tunnelAccountError: string | null
  copilotLogin: CopilotLogin | null
  copilotError: string | null
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

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
  // This month's premium use and limit state for each remote client.
  clients: ClientLimitStatus[]
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
}

declare global {
  interface Window {
    modelbridge: ModelBridgeAPI
  }
}
