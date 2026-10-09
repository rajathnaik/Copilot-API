# Copilot API Connector

Install Connector on a consumer machine, enter the Gateway/tunnel URL and API
key, and choose Codex, Claude Code, OpenCode, Hermes Agent, or OpenClaw.
Connector discovers models and writes each harness's native configuration.
It does not run a Gateway or require another Copilot sign-in.
The application is English-only; theme selection remains available.

[Download Windows 2.7.4](https://github.com/rajathnaik/Copilot-API/releases/download/connector-v2.7.4/Copilot.API.Connector.Setup.2.7.4.exe)
or choose [macOS/Linux downloads](https://github.com/rajathnaik/Copilot-API/releases/tag/connector-v2.7.4).
Run a newer installer in-place to upgrade under the same OS account.

Connector 2.7.4 makes the app English-only and includes the fork cleanup.
Connector 2.7.3 adds on-demand saved-key reveal and confirmed **Repair
connection** with private configuration backups. Ordinary Connect, Sync and
Undo still protect external changes from being overwritten.

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
