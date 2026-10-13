import type {
  AvailableModel,
  Source,
  SourceInput,
} from '@modelbridge/runtime/contracts'
import type { CopilotLogin } from '@modelbridge/runtime/copilot'
import type {
  CodexConfigurationStatus,
  CodexPreview,
} from '@modelbridge/runtime/codex'
import type { CodexInstallation } from '../electron/codex-discovery'

export interface AppStatus {
  version: string
  localUrl: string
  sources: Source[]
  models: AvailableModel[]
  sharing: boolean
  remoteUrl: string | null
  transportError: string | null
  login: { url: string; code: string } | null
  copilotLogin: CopilotLogin | null
  copilotError: string | null
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

export interface ModelBridgeAPI {
  status(): Promise<Result<AppStatus>>
  addSource(input: SourceInput): Promise<Result<AppStatus>>
  shareSource(sourceId: string, shared: boolean): Promise<Result<AppStatus>>
  localKey(): Promise<Result<string>>
  remoteKey(): Promise<Result<string>>
  loginTunnel(): Promise<Result<AppStatus>>
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
