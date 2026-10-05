# Copilot API

<p align="center">
  <img src="docs/hero/copilot-api-hero.svg" alt="Copilot API - Universal AI Gateway" width="1600" />
</p>

<p align="center">
  <strong>Universal AI Gateway</strong><br />
  One Gateway. Any Client. Multiple AI Providers.<br />
  Chat Completions &middot; OpenAI Responses &middot; Anthropic Messages
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@jeffreycao/copilot-api"><img src="https://img.shields.io/npm/v/@jeffreycao/copilot-api.svg" alt="npm version"></a>
  <a href="https://github.com/caozhiyuan/copilot-api/blob/dev/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://github.com/caozhiyuan/copilot-api/stargazers"><img src="https://img.shields.io/github/stars/caozhiyuan/copilot-api.svg" alt="GitHub stars"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/Bun-%3E%3D1.2.x-orange.svg" alt="Bun >= 1.2.x"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node-%3E%3D22.13.0-green.svg" alt="Node >= 22.13.0"></a>
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a>
</p>

Copilot API is a local AI gateway that connects Claude Code, OpenCode, Codex, and other clients to GitHub Copilot, the built-in Codex provider, and third-party model providers through a unified API.

## Highlights

- **Unified API Gateway**: Serve OpenAI-compatible Chat Completions (`/v1/chat/completions`), the OpenAI Responses API (`/v1/responses`), and Anthropic-compatible Messages (`/v1/messages`) from one local endpoint.
- **Multi-Provider**: Route GitHub Copilot, the built-in `codex` provider, and third-party providers (Kimi, DeepSeek, DashScope, OpenRouter, OpenCode Go, or a custom provider) behind the same gateway. GitHub Copilot is optional — with at least one enabled provider, the server starts in provider-only mode without a GitHub token.
- **Coding Agent Ready**: First-class setups for Claude Code, OpenCode, and Codex, including the interactive `--claude-code` launcher and a merged model catalog for Codex.
- **Streaming & WebSocket**: SSE streaming on all three client-facing protocols. Upstream Copilot Responses traffic selects WebSocket or HTTP from each model's advertised endpoints; streamed Responses traffic for the built-in `codex` provider uses WebSocket by default and uses HTTP when `useResponsesApiWebSocket` is disabled.
- **Desktop App**: Electron GUI with GitHub Copilot sign-in, Codex OAuth, provider configuration, token usage, logs, and one-click start/stop.

## Quick Start

Requires **Node.js >= 22.13.0** (npx) or **Bun >= 1.2.x**. A Copilot subscription is needed only for the GitHub Copilot provider; other configured providers can run independently.

```sh
npx @jeffreycao/copilot-api@latest start
```

The server listens on `http://localhost:4141` by default. Optionally authenticate with GitHub Copilot or configure a third-party provider first:

```sh
npx @jeffreycao/copilot-api@latest auth login
```

Verify the gateway is up:

```sh
curl http://localhost:4141/v1/models
```

> [!NOTE]
> Token usage storage requires Node.js >= 22.13.0 or Bun. See [Using with npx](docs/guides/en/getting-started.md#using-with-npx) for details.

From here, jump to the guide for your client: [Claude Code](docs/guides/en/claude-code.md#using-with-claude-code), [OpenCode](docs/guides/en/opencode.md#using-with-opencode), [Codex](docs/guides/en/codex.md#using-with-codex), or run it with [Docker](docs/guides/en/docker.md#using-with-docker).

## Compatibility

Every client talks to the same local endpoint. The gateway routes each request to GitHub Copilot, the built-in `codex` provider, or a configured third-party provider, translating between protocols when the provider speaks a different one.

**Client / Protocol Matrix**

| Client | Chat Completions | Responses | Anthropic Messages | Recommended |
|---|:---:|:---:|:---:|---|
| Claude Code | — | — | ✅ Native / Adapter | Anthropic Messages |
| OpenCode | ✅ Native | ✅ Native / Adapter | ✅ Native / Adapter via `@ai-sdk/anthropic` | Anthropic Messages |
| Codex | — | ✅ Native / Adapter | — | Responses |
| OpenAI-compatible clients | ✅ Native | ✅ Native / Adapter | — | Chat Completions |
| Anthropic-compatible clients | — | — | ✅ Native / Adapter | Anthropic Messages |

**Providers and protocols.** Protocol support is model-specific. Chat Completions requires a native endpoint, while Responses and Messages can use supported adapters. The built-in `codex` provider uses Responses natively; third-party providers can use `anthropic`, `openai-compatible`, or `openai-responses`, with per-model overrides.

## Desktop App

Prefer a GUI? The Electron desktop app in `desktop/` covers GitHub Copilot sign-in, OpenAI Codex OAuth, and API-key configuration for Kimi, DeepSeek, DashScope, OpenRouter, or a custom provider — with one-click start/stop of the local server, and the local endpoint, auth header, available models, usage, and logs in one window.

<p align="center">
  <img src="docs/screenshots/desktop-dashboard.png" alt="Copilot API desktop app dashboard" width="49%" />
  <img src="docs/screenshots/desktop-token-usage.png" alt="Copilot API desktop app token usage view" width="49%" />
</p>

Windows x64 (`.exe`), macOS Apple Silicon (`.dmg`), and Linux x64 (`.AppImage`) packages are published in [GitHub Releases](https://github.com/caozhiyuan/copilot-api/releases). See [Electron Desktop App](docs/guides/en/desktop.md#electron-desktop-app) for full setup and advanced configuration.

## Documentation

### Generate VS Code custom endpoint models

VS Code versions without custom endpoint discovery require an explicit model
list. Generate that list from this gateway with Python 3.9+ (standard library only):

```sh
python3 scripts/generate-vscode-models.py \
  --base-url "https://YOUR-TUNNEL-HOST/v1" \
  --secret-ref '${input:YOUR_EXISTING_VSCODE_SECRET}'
```

Copy the secret reference from the provider created by **Chat: Manage Language
Models > Add Models > Custom Endpoint**. The script prompts for the gateway key
without echoing it, or reads `COPILOT_API_KEY` if set. It never writes that key.

Open `vscode-models.generated.json` and copy its provider into the language-model
configuration opened by VS Code, replacing only the matching provider and
preserving other providers. Save and reload VS Code. The generator does not
modify VS Code settings automatically.

The script excludes embedding models, chooses Chat Completions, Responses, or
Messages from each model's advertised endpoints, and maps capabilities and token
limits. It fails explicitly when required metadata is missing. A listed model
is not proof of subscription access or successful inference; test chat and tools
after importing. Re-run with `--force` to refresh the generated file when the
catalog changes. Use `--catalog catalog.json` for an offline JSON catalog.

To update the existing Ubuntu VS Code configuration directly:

```sh
python3 scripts/generate-vscode-models.py \
  --base-url "https://YOUR-TUNNEL-HOST/v1" \
  --update-vscode "$HOME/.config/Code/User/chatLanguageModels.json"
```

Save and close the configuration editor before running this command, then reload
VS Code afterward. The script requires exactly one Custom Endpoint provider
named `My Copilot API` (override with `--name`), reuses its secure key reference,
preserves other providers and provider settings, removes its discovery URL, and
updates its model list. It creates a uniquely named backup beside the original
and replaces the configuration atomically. Concurrent file changes are checked
before replacement. JSON comments and trailing commas are rejected explicitly
without changing the file. Use the actual path from VS Code's **Copy Path**
command when using another profile, Insiders, or a different installation.

Run the generator tests with:

```sh
python3 -m unittest discover -s tests -p 'test_generate_vscode_models.py'
```

| Guide | Contents |
| --- | --- |
| [Installation and Startup](docs/guides/en/getting-started.md) | Prerequisites, project overview, `npx` and source runs, provider-only mode without Copilot, and gateway API key setup |
| [Claude Code](docs/guides/en/claude-code.md) | The `--claude-code` interactive launcher, `.claude/settings.json` environment variables, opus / sonnet / haiku tier mapping, auto-compact window, and WebSearch behavior |
| [OpenCode](docs/guides/en/opencode.md) | OpenCode OAuth login, the `@ai-sdk/anthropic` provider in `opencode.json`, `baseURL` conventions, model context limits, and thinking options |
| [Codex](docs/guides/en/codex.md) | A full `config.toml` provider block, `GITHUB_COPILOT_API_KEY` environment variable setup, auto-review model mapping, generating `model_catalog.json`, and the merged model picker catalog with protocol adapters |
| [Docker](docs/guides/en/docker.md) | Docker Compose quick start, the `/data` persistent mount and its ownership repair, supported environment variables, and host interface binding |
| [Desktop App](docs/guides/en/desktop.md) | Copilot sign-in, Codex OAuth account switching, API-key providers, one-click start / stop, shared model mappings, advanced settings, and per-platform installers |
| [Plugins and Tool Search](docs/guides/en/integrations.md) | The Responses `tool_search` MCP bridge (not needed on opencode v2, which already defers tools through Code Mode), Claude Code `agent-inject` and `tool-search` marketplace plugins, and the opencode subagent marker plugin |
| [Usage Monitoring](docs/guides/en/usage.md) | The usage viewer URL and query parameters, period selectors, Copilot quota progress, token and cost metric cards, trend charts, and paginated request events |
| [CLI Reference](docs/guides/en/cli.md) | Command structure, global options, and the full option sets for the `start`, `auth`, and `debug` subcommands with example usage |
| [Configuration Reference](docs/guides/en/configuration.md) | Every `config.json` field: gateway and admin API keys, provider definitions, model mappings, WebSocket and HTTP transport, timeouts, and context management |
| [API and Authentication](docs/guides/en/api.md) | Allowed auth headers and CORS rules, OpenAI, Codex backend, and Anthropic endpoints, usage monitoring routes, and admin configuration endpoints |
| [Troubleshooting](docs/guides/en/troubleshooting.md) | Fixes for Copilot encrypted output failures and missing Claude models |

Before using GitHub Copilot, read the [GitHub Copilot Security Notice](NOTICE.md#github-copilot-security-notice).
