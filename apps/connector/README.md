# Copilot API Connector

Install Connector on a consumer machine, enter the Gateway/tunnel URL and API
key, and choose Codex, Claude Code, OpenCode, Hermes Agent, or OpenClaw.
Connector discovers models and writes each harness's native configuration.
It does not run a Gateway or require another Copilot sign-in.

[Download Windows 2.7.2](https://github.com/rajathnaik/Copilot-API/releases/download/connector-v2.7.2/Copilot.API.Connector.Setup.2.7.2.exe)
or choose [macOS/Linux downloads](https://github.com/rajathnaik/Copilot-API/releases/tag/connector-v2.7.2).
Run a newer installer in-place to upgrade under the same OS account.

Saved-key reveal and confirmed **Repair connection** require Connector 2.7.3
or newer. These fixes are in the source and local 2.7.3 installer; the public
download above remains 2.7.2 until the next approved release.

From the repository root, run `bun install --frozen-lockfile` once, then:

```sh
bun run build:connector
bun run --cwd apps/connector dev
bun run --cwd apps/connector test
bun run --cwd apps/connector package:win
```

Version is owned by this project's [package.json](package.json). Releases use
`connector-v<version>` tags and require explicit approval. Source pushes do not
publish installers. See the [Connector guide](../../docs/guides/en/connector.md)
for setup, supported protocols, Sync/Undo, credential storage, and native tests.
