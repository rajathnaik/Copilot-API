# Installation and Startup

[Home](../../../README.md) | [Documentation](README.md)

## Choose the right product

- **Gateway:** run on the host with Copilot/provider access. It handles
  authentication, model discovery, API serving and Microsoft Dev Tunnels.
- **Connector:** install on each consumer machine. Enter the Gateway URL and
  API key, choose a harness and connect. It does not need a local Gateway or
  another Copilot sign-in. Start with the [Connector guide](connector.md).

The Gateway retains OpenAI Chat Completions, OpenAI Responses and Anthropic
Messages, provider-only operation, streaming, usage monitoring and manual
client integration. Both desktop applications are English-only.

## Prerequisites

Installed desktop releases bundle their runtime. Source development requires:

- Bun 1.4.2 (tested).
- Node.js `^22.18.0 || ^24.11.0 || >=26.0.0` for the build toolchain.
- A Copilot subscription for the GitHub Copilot provider, or an API key/OAuth
  login for a supported alternative provider.
- Microsoft Dev Tunnels CLI and sign-in on the host if you want remote access.
  Gateway's Remote Access screen provides install/sign-in guidance.

## Installation

This fork publishes explicitly approved product installers at
[rajathnaik/Copilot-API releases](https://github.com/rajathnaik/Copilot-API/releases).
- [Gateway 2.7.1](https://github.com/rajathnaik/Copilot-API/releases/tag/v2.7.1):
  install on the host with Copilot/provider access.
- [Connector 2.7.4](https://github.com/rajathnaik/Copilot-API/releases/tag/connector-v2.7.4):
  install on each coding-harness consumer.

Both releases provide Windows x64, macOS arm64 and Linux x64 installers and
SHA256 checksums. Upstream npm packages and registry images are different builds.
There is no npm installation command for this fork.

For source development:

```sh
git clone https://github.com/rajathnaik/Copilot-API.git
cd Copilot-API
bun install --frozen-lockfile
```

Run one install at the workspace root, not separate installs in each app.

## Running from Source

### Gateway desktop

```sh
bun run --cwd apps/gateway/desktop dev
```

On Windows, [launch-desktop.ps1](../../../launch-desktop.ps1) builds stale
bundles and launches the checkout. See [Desktop App](desktop.md).

### Gateway CLI

Run from the repository root:

```sh
bun run start auth login
bun run start start
```

For watch mode, use `bun run dev start`. The trailing `start` is the Gateway
CLI subcommand, not a typo. To build and run the CLI:

```sh
bun run build
bun apps/gateway/dist/main.js start
```

The default listener is `http://127.0.0.1:4141`. Verify model discovery:

```sh
curl http://127.0.0.1:4141/v1/models
```

If Gateway API keys are enabled, provide the configured key in an
`Authorization: Bearer` or `x-api-key` header. Do not share raw credentials
in screenshots, diagnostics or committed files.

### Network access and providers

Prefer **Settings > Security** in Gateway to configure client keys. CLI users
can manage keys and listener options as follows; note that arguments are
visible in process listings and shell history:

```sh
bun run start auth keys --add YOUR_GATEWAY_API_KEY
bun run start start --host 0.0.0.0 --port 8080
```

Non-loopback listeners require a Gateway API key and restrict CORS to
same-origin requests. For consumer access through Microsoft Dev Tunnels, use
Gateway's Remote Access screen and Connector rather than hand-editing configs.

Copilot is optional. Configure an enabled provider before starting without a
GitHub token:

```sh
bun run start auth login --provider dashscope
bun run start start
```

See the [CLI reference](cli.md), [API authentication](api.md) and
[locally built Docker setup](docker.md). Before using Copilot, read the
[responsible-use notice](../../../NOTICE.md#github-copilot-security-notice).
