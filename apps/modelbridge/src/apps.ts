import type { Protocol } from '@modelbridge/runtime/contracts'
import type { UsageApp } from '@modelbridge/runtime/usage'

export type HarnessId = 'codex' | 'claude-code' | 'hermes' | 'openclaw'
export type AppId = HarnessId | 'openai' | 'anthropic'

export interface AppInfo {
  id: AppId
  name: string
  // The API this app speaks to ModelBridge.
  protocol: Protocol
  description: string
  // Apps ModelBridge can configure for you; the rest get a copy-ready setup.
  automatic: boolean
}

export const apps: AppInfo[] = [
  {
    id: 'codex',
    name: 'Codex',
    protocol: 'responses',
    description: 'OpenAI Codex CLI and desktop app.',
    automatic: true,
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    protocol: 'messages',
    description: 'Anthropic’s terminal coding agent.',
    automatic: true,
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    protocol: 'chat-completions',
    description: 'Nous Research’s self-improving agent.',
    automatic: true,
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    protocol: 'chat-completions',
    description: 'Personal assistant gateway for chat apps.',
    automatic: true,
  },
  {
    id: 'openai',
    name: 'Other (OpenAI-compatible)',
    protocol: 'chat-completions',
    description:
      'Any tool with a custom OpenAI base URL: Cline, Continue, Aider, LibreChat and more.',
    automatic: false,
  },
  {
    id: 'anthropic',
    name: 'Other (Anthropic-compatible)',
    protocol: 'messages',
    description: 'Any tool that accepts a custom Anthropic base URL.',
    automatic: false,
  },
]

export const protocolLabels: Record<Protocol, string> = {
  responses: 'Responses',
  'chat-completions': 'Chat Completions',
  messages: 'Anthropic Messages',
}

export const protocolPaths = {
  responses: '/v1/responses',
  'chat-completions': '/v1/chat/completions',
  messages: '/v1/messages',
} as const satisfies Record<Protocol, string>

export const usageAppLabels: Record<UsageApp | 'unknown', string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  hermes: 'Hermes Agent',
  openclaw: 'OpenClaw',
  playground: 'Playground',
  other: 'Other tools',
  unknown: 'Earlier requests (app not recorded)',
}
