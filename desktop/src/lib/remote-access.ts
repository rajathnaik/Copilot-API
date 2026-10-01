import { SNIPPET_API_KEY_PLACEHOLDER } from './playground'

export type ClientSetupId = 'curl' | 'claudeCode' | 'codex' | 'openaiSdk'

export interface ClientSetup {
  id: ClientSetupId
  title: string
  language: 'bash' | 'toml' | 'python'
  code: string
}

export function normalizePublicUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

export function buildClientSetups(
  publicUrl: string,
  apiKey = SNIPPET_API_KEY_PLACEHOLDER,
): ClientSetup[] {
  const baseUrl = normalizePublicUrl(publicUrl)

  return [
    {
      id: 'curl',
      title: 'Quick test (curl)',
      language: 'bash',
      code: [
        `curl ${baseUrl}/v1/models \\`,
        `  -H "Authorization: Bearer ${apiKey}"`,
      ].join('\n'),
    },
    {
      id: 'claudeCode',
      title: 'Claude Code',
      language: 'bash',
      code: [
        '# macOS / Linux',
        `export ANTHROPIC_BASE_URL=${baseUrl}`,
        `export ANTHROPIC_AUTH_TOKEN=${apiKey}`,
        'claude',
        '',
        '# Windows PowerShell',
        `$env:ANTHROPIC_BASE_URL = "${baseUrl}"`,
        `$env:ANTHROPIC_AUTH_TOKEN = "${apiKey}"`,
        'claude',
      ].join('\n'),
    },
    {
      id: 'codex',
      title: 'Codex (~/.codex/config.toml)',
      language: 'toml',
      code: [
        '# Set GITHUB_COPILOT_API_KEY to your gateway API key first.',
        'model_provider = "copilot_api"',
        '',
        '[model_providers.copilot_api]',
        'name = "OpenAI"',
        `base_url = "${baseUrl}"`,
        'env_key = "GITHUB_COPILOT_API_KEY"',
        'requires_openai_auth = true',
        'supports_websockets = false',
        'wire_api = "responses"',
      ].join('\n'),
    },
    {
      id: 'openaiSdk',
      title: 'OpenAI-compatible SDK / tools',
      language: 'python',
      code: [
        'from openai import OpenAI',
        '',
        'client = OpenAI(',
        `    base_url="${baseUrl}/v1",`,
        `    api_key="${apiKey}",`,
        ')',
        'reply = client.chat.completions.create(',
        '    model="gpt-4.1",',
        '    messages=[{"role": "user", "content": "Hello!"}],',
        ')',
        'print(reply.choices[0].message.content)',
      ].join('\n'),
    },
  ]
}
