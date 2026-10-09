# Copilot API: Gateway and Connector

An independently maintained fork by [Rajath Naik](https://github.com/rajathnaik),
built around a simple host-and-consumer setup. Run Gateway on the machine with
your Copilot subscription; install Connector wherever you use a coding harness.
Both applications and this repository's documentation are English-only.

[MIT license](LICENSE) | [Documentation](docs/guides/en/README.md) |
[Project lineage and responsible use](NOTICE.md)

## Two independent products

| Product | Install it on | What it does |
| --- | --- | --- |
| [Gateway](apps/gateway/README.md) | The host with Copilot/provider access | Signs in, serves APIs, discovers available models and manages a Microsoft Dev Tunnel |
| [Connector](apps/connector/README.md) | Each consumer machine | Uses the host URL and API key to configure Codex, Claude Code, OpenCode, Hermes Agent or OpenClaw |

Connector does not run another Gateway, require another Copilot sign-in, or
need to be hosted as a service. It is a local desktop application that manages
each harness's native configuration and protected credentials.

## Downloads

- **Connector:** [Windows installer 2.7.4](https://github.com/rajathnaik/Copilot-API/releases/download/connector-v2.7.4/Copilot.API.Connector.Setup.2.7.4.exe)
  or [macOS arm64 / Linux x64](https://github.com/rajathnaik/Copilot-API/releases/tag/connector-v2.7.4).
  Run newer installers in-place under the same OS account.
- **Gateway:** [Windows installer 2.7.1](https://github.com/rajathnaik/Copilot-API/releases/download/v2.7.1/Copilot.API.Setup.2.7.1.exe)
  or [macOS arm64 / Linux x64](https://github.com/rajathnaik/Copilot-API/releases/tag/v2.7.1).
  Install on the host machine; the packaged app does not require the source tree.

Download only the intended product from
[this fork's releases](https://github.com/rajathnaik/Copilot-API/releases).
Upstream npm packages and container images are not builds of this fork.
Gateway tags use `v<version>`; Connector tags use `connector-v<version>`.
Do not use a repository-wide "latest" URL to choose between the products.

## Quick start

### Host machine

1. Launch Gateway and sign in with your Copilot subscription, or configure a
   supported alternative provider.
2. Configure a Gateway API key in **Settings > Security** and start the API.
3. In **Remote Access**, sign in to Microsoft Dev Tunnels and start the tunnel.
4. Share the tunnel URL and Gateway key securely with the consumer.

A local source checkout requires Bun **1.4.2** (the tested version) and a
supported Node.js build runtime: **22.18+ in the 22.x series, 24.11+ in the
24.x series, or 26+**.

```sh
git clone https://github.com/rajathnaik/Copilot-API.git
cd Copilot-API
bun install --frozen-lockfile
bun run --cwd apps/gateway/desktop dev
```

On Windows, [launch-desktop.ps1](launch-desktop.ps1) also starts the Gateway
from a checkout and builds stale bundles. An installed desktop release bundles
its runtime and does not require Bun, Node.js or the source tree.

### Consumer machine

1. Install Connector and your chosen coding harness.
2. Enter the Microsoft Dev Tunnels/Gateway URL and API key.
3. Choose the harness, discover models, choose a default and click **Connect**.
4. Start a fresh harness session.

Connector verifies setup, supports model sync and safe Undo, and offers
explicit saved-key reveal. If connector-owned settings were changed externally,
**Repair connection** requires confirmation and creates a private backup first.
See the [Connector guide](docs/guides/en/connector.md) for credential storage,
permissions and per-harness limitations.

## Gateway capabilities retained

- OpenAI-compatible Chat Completions, OpenAI Responses and Anthropic Messages.
- Native endpoint discovery, supported protocol adapters, SSE streaming and
  model-aware Responses WebSocket/HTTP transport.
- Copilot authentication, built-in Codex OAuth and third-party/custom providers,
  including provider-only operation without a Copilot subscription.
- API/admin keys, provider configuration, model routing, usage history, logs,
  the usage web page and optional Claude Code/OpenCode plugins.
- CLI operation and [locally built Docker containers](docs/guides/en/docker.md).

Protocol support is model-specific. Codex uses Responses; Claude Code uses
Messages; other clients use the native protocol configured for their harness.
Discovering a model does not guarantee subscription access or successful chat.

<p align="center">
  <img src="docs/screenshots/desktop-dashboard.png" alt="Gateway dashboard" width="49%" />
  <img src="docs/screenshots/desktop-token-usage.png" alt="Gateway token usage" width="49%" />
</p>

## Development and releases

| Location | Responsibility |
| --- | --- |
| [apps/gateway](apps/gateway/) | Gateway API, desktop host application, server tests and runtime usage page |
| [apps/connector](apps/connector/) | Independent consumer application, harness adapters, credentials and installer |
| [packages/shared](packages/shared/) | Private bundled file-writing, English strings, theme and styling utilities |
| [plugin](plugin/) | Optional functional Gateway integrations |
| [scripts](scripts/) / [tests](tests/) | Shared development tools and workspace checks |

Install once at the root; do not install nested workspaces separately.

```sh
bun run dev start
bun run build:gateway
bun run build:connector
bun run typecheck:all
bun run lint:all
bun run test
bun run knip
```

Knip is an inventory aid, not a deletion command: test-only exports, shared
workspace dependencies and runtime-loaded Electron code need contextual review.
Build outputs, installers, caches, credentials and dependency folders are not
source files and must not be committed.

CI validates source pushes; it does not publish installers. Product versions,
tags and installers are independent. Releases require explicit product/version
approval, tested committed source and public-download verification. This fork
does not publish npm packages, registry container images or a GitHub Pages site.
The runtime usage page remains part of Gateway.

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
python3 -m unittest discover -s apps/gateway/tests -p 'test_generate_vscode_models.py'
```

| Guide | Contents |
| --- | --- |
| [Installation and Startup](docs/guides/en/getting-started.md) | Host/consumer setup, source runs, provider-only mode and Gateway API keys |
| [Claude Code](docs/guides/en/claude-code.md) | The `--claude-code` interactive launcher, `.claude/settings.json` environment variables, opus / sonnet / haiku tier mapping, auto-compact window, and WebSearch behavior |
| [OpenCode](docs/guides/en/opencode.md) | OpenCode OAuth login, the `@ai-sdk/anthropic` provider in `opencode.json`, `baseURL` conventions, model context limits, and thinking options |
| [Codex](docs/guides/en/codex.md) | A full `config.toml` provider block, `GITHUB_COPILOT_API_KEY` environment variable setup, auto-review model mapping, generating `model_catalog.json`, and the merged model picker catalog with protocol adapters |
| [Docker](docs/guides/en/docker.md) | Docker Compose quick start, the `/data` persistent mount and its ownership repair, supported environment variables, and host interface binding |
| [Desktop App](docs/guides/en/desktop.md) | Copilot sign-in, Codex OAuth account switching, API-key providers, one-click start / stop, shared model mappings, advanced settings, and per-platform installers |
| [Copilot API Connector](docs/guides/en/connector.md) | Five native harnesses, secure credentials, discovery, verification, sync, repair and safe Undo |
| [Plugins and Tool Search](docs/guides/en/integrations.md) | The Responses `tool_search` MCP bridge (not needed on opencode v2, which already defers tools through Code Mode), Claude Code `agent-inject` and `tool-search` marketplace plugins, and the opencode subagent marker plugin |
| [Usage Monitoring](docs/guides/en/usage.md) | The usage viewer URL and query parameters, period selectors, Copilot quota progress, token and cost metric cards, trend charts, and paginated request events |
| [CLI Reference](docs/guides/en/cli.md) | Command structure, global options, and the full option sets for the `start`, `auth`, and `debug` subcommands with example usage |
| [Configuration Reference](docs/guides/en/configuration.md) | Every `config.json` field: gateway and admin API keys, provider definitions, model mappings, WebSocket and HTTP transport, timeouts, and context management |
| [API and Authentication](docs/guides/en/api.md) | Allowed auth headers and CORS rules, OpenAI, Codex backend, and Anthropic endpoints, usage monitoring routes, and admin configuration endpoints |
| [Troubleshooting](docs/guides/en/troubleshooting.md) | Fixes for Copilot encrypted output failures and missing Claude models |

Before using GitHub Copilot, read the [GitHub Copilot Security Notice](NOTICE.md#github-copilot-security-notice).
