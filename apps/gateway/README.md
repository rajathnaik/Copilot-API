# Copilot API Gateway

Gateway signs in to Copilot or other providers and serves OpenAI- and
Anthropic-compatible APIs. Run it on the host machine; consumers use the
separate Connector with the host's URL and API key.

The API package and Electron desktop app share the Gateway version.
Gateway releases use `v<version>` tags, independently of Connector releases.

[Download Windows 2.7.1](https://github.com/rajathnaik/Copilot-API/releases/download/v2.7.1/Copilot.API.Setup.2.7.1.exe)
or choose [macOS/Linux downloads](https://github.com/rajathnaik/Copilot-API/releases/tag/v2.7.1).
This fork's packaged app bundles its runtime and preserves the Gateway's
existing sign-in and settings locations.

From the repository root:

```sh
bun install --frozen-lockfile
bun run dev start
bun run build
bun run build:gateway
bun run --cwd apps/gateway test
bun run --cwd apps/gateway/desktop test
```

This fork is distributed through approved installers and source, not npm.
For the source CLI, use `bun run start auth login` and `bun run start start`
from the root. On Windows, [launch-desktop.ps1](../../launch-desktop.ps1)
starts the source desktop app.
The UI is English-only; existing sign-in and settings locations are preserved.
Docker Compose builds this fork locally rather than pulling upstream images.
For setup, supported providers, API authentication, and Docker usage, see the
[repository documentation](https://github.com/rajathnaik/Copilot-API#readme).
