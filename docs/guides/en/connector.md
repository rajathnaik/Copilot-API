# Copilot API Connector

[Home](../../../README.md) · [Documentation](README.md)

Copilot API Connector is a separate, client-only desktop application. Codex is
its first supported harness. It does not start a gateway, host a tunnel, or ask
the consumer to sign in to GitHub Copilot.

## Host and consumer setup

On the host, keep using Copilot API Desktop: sign in to Copilot, configure
gateway API keys, and start the gateway and Microsoft Dev Tunnel. Both must
remain running while consumers use the API. Prefer a separate gateway key for
each consumer, and share it securely.

On the consumer:

1. Install Codex CLI **0.160.0 or newer**, or use a Codex desktop installation
   with an accessible compatible native Codex executable.
2. Install **Copilot API Connector**, not the host gateway application.
3. Enter the tunnel's HTTPS URL and **gateway API key**.
4. Click **Connect Codex**, then restart Codex.

Only the URL and key are required connection inputs. **Discover models** is an
optional preview that lets you choose the default model. Codex executables are
detected from PATH, common npm locations, and common desktop locations. If
detection fails, use **Select Codex executable**; on Windows choose the native
`codex.exe`, not a PowerShell or `.cmd` wrapper.

The URL can end in `/v1`; the connector normalizes it to the gateway root.
Other path prefixes, credentials in URLs, query strings, and fragments are
rejected. HTTP is accepted only for loopback development gateways. Redirects
are rejected without forwarding the key.

The two-input workflow requires a tunnel accessible without a separate tunnel
login. Gateway API-key authentication must still be enabled. A gateway key
does not replace Microsoft Dev Tunnels transport authentication.

## What Connect changes

The connector edits the user-level Codex configuration, respecting `CODEX_HOME`
when set, otherwise using the native user's `.codex` directory. It installs a
provider named `copilot_api_connector` and selects a discovered default model.
An existing provider with that name is never claimed without saved ownership.

Configuration is parsed as TOML and edited by source ranges. Unrelated
providers, comments, permissions, sandbox policy, account credentials, and
other settings are preserved. Existing global context-window, auto-compaction,
and reasoning-effort overrides are removed so model-specific catalog metadata
can apply; their original values are saved for Undo. The connector does not
copy the permissive sandbox settings from manual configuration examples.

Discovery intersects the gateway's ordinary model list with its complete Codex
catalog. Embeddings and models explicitly lacking tool support are excluded.
Models lacking compatible catalog metadata are also excluded and shown in the
discovery preview. Catalog metadata comes from the gateway; discovery alone
does not prove subscription authorization or successful inference.

Codex uses native remote discovery only when the remote catalog includes the
same eligible model IDs as the complete catalog and fits its **1 MiB** limit.
Otherwise the connector installs a complete local catalog. This avoids silently
losing models through remote catalog size limits or gateway fallback entries.

## Credentials and verification

The gateway key is encrypted using Electron's OS-protected `safeStorage` and
stored only in the connector's user-data directory. It is not written into
Codex TOML, a repository, model catalogs, or logs. Plaintext Linux backends and
unrecognized keychain backends are rejected; enable a supported system
keychain before connecting.

Codex invokes the installed connector executable as a short-lived credential
helper. Its stdout carries the token directly to Codex. Closing the connector
window does not break authentication. Keep it installed and do not move its
executable or Linux AppImage after configuration; reconnect if its path changes.
Setup preflights that helper before launching Codex, so keychain or helper
failures are reported without waiting for Codex authentication retries.

Connect and Sync perform two small inference checks on the selected model:

- A Responses SSE request must complete the expected synthetic function call.
  The function does not execute code.
- The actual Codex CLI must return a precise test reply using the configured
  provider, model catalog, and credential helper.

The CLI check uses an isolated temporary Codex home, a read-only sandbox, and
disabled web search/analytics, rather than loading the user's MCP servers or
project settings. Piped stdin is closed, execution is bounded, and the temporary
directory is removed afterward.

These checks may consume subscription allowance. Only the selected model is
inference-verified; other models remain discovery-compatible, not verified.

## Sync, key rotation, and Undo

- **Sync models** reuses the encrypted saved key, updates the catalog, and
  verifies the existing selected model. A removed selected model requires an
  explicit replacement; the connector does not silently reroute requests.
- To change the tunnel URL or rotate the key, enter the new values and
  reconnect. The first pre-connector model settings remain available for Undo.
- **Undo connection** requires confirmation. Close Codex sessions first.
  Connector-owned settings are removed and the original model settings are
  restored, while later unrelated edits are retained. The saved gateway key,
  catalog, and connection state are removed.

Writes are atomic and protected by a transaction journal and an exclusive
setup lock. Verification failure rolls back configuration, catalog, credential,
and state together. Startup recovers interrupted transactions and identifiable
dead-process locks. If files were edited externally during setup or recovery,
the connector refuses to overwrite those edits and retains the recovery
journal with an actionable error.

Connector-managed fields edited outside the app also block reconnect and Undo.
Restore those fields first. For ambiguous stale locks, the error identifies the
exact lock file that can be removed after closing the connector. Recovery data
can contain prior configuration secrets: keep the user-data directory private
and do not upload its contents when reporting a problem.

Undo before uninstalling. Uninstalling while connected leaves Codex pointing
at a missing credential helper.

## Supported environments

The connector has separate Windows NSIS, macOS DMG, and Linux AppImage packaging
with a distinct application ID and no gateway/server resources. Host and
connector applications can coexist. Release builds currently use the
repository's existing signing policy; automatic connector updates are not
implemented.

It configures Codex in its **native OS environment**. A Windows connector does
not configure a separate WSL installation. Native desktop apps must be restarted
to load changes, and managed or project configuration can still override user
settings. The isolated smoke test proves the provider connection, not every
configuration layer of an existing session.

Custom-provider configuration is intended for local Codex clients, not hosted
Codex orchestration that disallows custom providers. Claude Code and other
harness adapters are not implemented in this release.

## Build and validation

From `desktop` after installing its declared dependencies:

```sh
bun run dev:connector
bun run build:connector
bun run package:connector:win
bun run package:connector:mac
bun run package:connector:linux
```

Connector packaging does **not** run `build:server`. Output goes to
`desktop/release-connector`, separate from host artifacts. The desktop release
workflow builds and uploads both products on release tags.

Focused tests:

```sh
bun test --coverage tests/connector.test.ts tests/connector-ui.test.ts tests/remote-access.test.ts
bun run typecheck
```

The optional native integration test uses a local synthetic gateway and never
sends prompts to a real subscription. Set `CONNECTOR_TEST_CODEX` to an absolute
native Codex executable path, then run:

```sh
bun test tests/connector-integration.test.ts
```

To exercise actual OS encryption and the connector's credential helper as
well, build the connector and set `CONNECTOR_TEST_ELECTRON` to the development
Electron executable. Optionally set `CONNECTOR_TEST_HELPER` to the packaged
connector executable to test the shipped helper. These checks use isolated
temporary data and synthetic keys, not your real gateway or Codex settings.

Electron's standard `--user-data-dir=<absolute-path>` switch can isolate
connector data for development and testing. The generated helper configuration
keeps that path, so credential reads do not depend on a shell environment.
