# Copilot API Connector

[Home](../../../README.md) · [Documentation](README.md)

Copilot API Connector is a separate, client-only desktop application with
configurations for **Codex, Claude Code, OpenCode, Hermes Agent and OpenClaw**.
It does not start a gateway, host a tunnel, or ask
the consumer to sign in to GitHub Copilot.

## Host and consumer setup

On the host, keep using Copilot API Desktop: sign in to Copilot, configure
gateway API keys, and start the gateway and Microsoft Dev Tunnel. Both must
remain running while consumers use the API. Prefer a separate gateway key for
each consumer, and share it securely.

On the consumer:

1. Install your harness's current native CLI. Codex requires **0.160.0+**,
   including the compatible CLI bundled with its desktop app. Claude Code
   requires **2.1.242+** for its native gateway-model picker.
2. Install **Copilot API Connector**, not the host gateway application.
3. Select the coding harness and enter the tunnel's HTTPS URL and **gateway
   API key**.
4. Click **Connect**, then restart that harness. For OpenCode, explicitly
   accept the readable-key warning before connecting.

The **Gateway connection** selector can copy the URL and encrypted saved key
from an existing configuration. Copying stays in the main process; the key is
returned to the renderer only if **Show key** is explicitly requested. Each
harness still owns an independent credential,
default model, transaction journal, Sync and Undo history. Rotating or undoing
one connection does not change the others. A copied key cannot be silently
sent to a different URL: switch to entering a new gateway/key instead.

Only the URL and key are required connection inputs. **Discover models** is an
optional preview that lets you choose the default model. Codex executables are
detected from PATH, npm global locations/custom prefixes, and desktop installs.
On Windows, Microsoft Store package metadata and registered install locations
are checked, including the native CLI bundled in the desktop app. Versioned
Store paths are discovered rather than hardcoded, so app updates can move them.
Outdated or broken automatically discovered candidates do not prevent checking
other installations.

If Codex is missing, use **Install or update Codex** for official instructions,
then **Retry detection**. The connector does not install software without
permission. **Advanced troubleshooting** keeps manual executable selection
available for custom/portable installs; on Windows select native `codex.exe`,
not a PowerShell or `.cmd` wrapper. **Use automatic detection** clears only
that override, not your connection or Codex settings.

Other harnesses are found from PATH, their native user installation locations,
Hermes virtual environments and supported npm layouts. Windows npm JavaScript
entry points are run through an installed Node executable rather than
PowerShell or `.cmd` shims. Install guides and Advanced executable overrides
apply to the selected harness. No harness or gateway is installed automatically.

The header offers **Light**, **Dark**, and **System** themes. This preference
is saved independently of the gateway application; System follows OS changes.
The connector uses its own interlocking-link icon in the UI and installers.
Technical catalog/configuration details are collapsed by default.

The URL can end in `/v1`; the connector normalizes it to the gateway root.
Other path prefixes, credentials in URLs, query strings, and fragments are
rejected. HTTP is accepted only for loopback development gateways. Redirects
are rejected without forwarding the key.

The two-input workflow requires a tunnel accessible without a separate tunnel
login. Gateway API-key authentication must still be enabled. A gateway key
does not replace Microsoft Dev Tunnels transport authentication.

## Installing, upgrading, and removing the Windows connector

Use the installer on the computer running the coding harness. Copy it to that
computer if the gateway and consumer are different machines; the consumer does
not need the gateway application.

For an upgrade, close the connector and pause active harness sessions, then run
the newer installer under the same Windows account. Keep its existing install
location. The standard installer replaces application files and preserves
saved profiles and OS-encrypted credentials; uninstalling first is unnecessary.

The connector has its own release version in
`apps/connector/package.json` (`version`), independent of the
gateway's package version. The published multi-harness follow-up release is **2.7.2**,
with installer **Copilot.API.Connector.Setup.2.7.2.exe**. Earlier Codex-only and
multi-harness builds both used 2.7.0 and the same installer filename, so an older
downloaded copy is not distinguishable by its name/version alone.

[Download the Windows Connector installer](https://github.com/rajathnaik/Copilot-API/releases/download/connector-v2.7.2/Copilot.API.Connector.Setup.2.7.2.exe).
This single setup file installs the packaged app; consumers do not need to
download, clone or build the source project.

Saved-key reveal and confirmed **Repair connection** are available in the
2.7.3 source/local installer. The public download remains 2.7.2 until a separate
release is approved; updating the source does not update an installed app.

After installation, open Copilot API Connector from the Start menu and verify
**Connector version 2.7.2** in its header and all five harness options. If an old
window was still running, fully exit it and reopen the app. If the old UI still
appears, check the launched executable's location and Windows file properties
before removing anything; the shortcut may point to another installation.
Installing on a different Windows account does not update the first account's
per-user installation.

For permanent removal, Undo each configured connection before uninstalling
through Windows Settings > Apps > Installed apps. Do not uninstall a
helper-backed connection while Undo is blocked by external configuration edits:
removing the executable can break authentication. Upgrading preserves that
ownership conflict rather than clearing or overwriting it.

Updates remain manual; there is no automatic connector updater.

## Publishing an approved Connector release

Normal commits and branch pushes run checks, not publishing. After a commit/push
handled by the coding assistant, it asks whether to release and proposes the
affected product/version. A push does not itself grant release approval.
The assistant cannot display a prompt for pushes made outside its session;
publishing still requires a deliberate release tag or manual Actions run.

For an approved stable Connector release:

1. Set its independent `version` in `apps/connector/package.json`.
2. Check, commit and push the source. Never reuse a published version.
3. After approval, push `connector-v<version>` at that tested commit, or run
   **Release Connector** manually with that exact version and source ref.
   An existing tag must point to that source commit. Failed tags are not moved
   silently; use a new version for a corrected release.
4. The workflow validates the version and product identity, runs checks, builds
   Windows/macOS/Linux installers, checks the Windows credential helper, and
   publishes a Connector-specific release with SHA256 checksums.
5. Verify the Windows installer download and share that direct asset link.

The Connector workflow does not publish on Gateway `v*` tags. Gateway release
jobs no longer build Connector installers, and Connector releases do not replace
the repository's global latest Gateway release. GitHub Actions publishes with
its repository-scoped workflow token; no personal token belongs in source.

GitHub has only one repository-wide latest release. When Connector is the
repository's first stable release, `/releases/latest` can still return it despite
`--latest=false`. Keep it stable and use the product-specific download link above,
not a generic latest-release link. An approved Gateway release can take the
Latest designation when it is published.

## Protocols and native configurations

| Harness | Protocol and request endpoint | Configured API base | Credential integration |
| --- | --- | --- | --- |
| Codex | OpenAI Responses, `/responses` | Gateway root | Command-backed provider auth |
| Claude Code | Anthropic Messages, `/v1/messages` | Gateway root | `apiKeyHelper`, token-only stdout |
| OpenCode | Anthropic Messages, `/v1/messages`, `@ai-sdk/anthropic` | Root + `/v1` | Readable `options.apiKey`, explicit opt-in |
| Hermes Agent | OpenAI Chat Completions, `/v1/chat/completions` | Root + `/v1` | Named custom provider `key_cmd`, token-only stdout |
| OpenClaw | OpenAI Chat Completions, `/v1/chat/completions`, `openai-completions` | Root + `/v1` | Executable `SecretRef`, single-ID JSON-string stdout |

These are native harness configurations, not separate connectors, gateways or
protocol-conversion servers. The host gateway already provides the required
API routes. Non-Codex discovery uses `/v1/models`, not the special Codex catalog;
embeddings and explicit non-tool models are excluded. Available model limits
and vision metadata are copied when advertised, not fabricated from names.

- **Claude Code:** user `settings.json` under `CLAUDE_CONFIG_DIR` or `~/.claude`.
  Setup selects the discovered wire model, sets the root URL and helper, and
  routes default/background tiers to that selected model. Conflicting user-level
  model overrides, old credential variables and Bedrock/Vertex/Foundry routing
  are neutralized and saved for Undo. Permissions and saved Claude login
  credentials are not changed. Claude may request its normal API-key approval.
  All discovered IDs are added through `modelPicker.options`, including
  non-Claude/opaque gateway IDs that optional startup discovery filters out.
  Existing custom picker rows and later unrelated additions are retained;
  Sync replaces only connector-marked rows. `availableModels` restrictions and
  a managed model-picker lineup are not bypassed.
- **OpenCode:** `OPENCODE_CONFIG`, or the highest existing global file under
  `$XDG_CONFIG_HOME/opencode` / `~/.config/opencode` (`opencode.jsonc`,
  `opencode.json`, legacy `config.json`); a new setup creates `opencode.jsonc`.
  Setup adds the Anthropic provider and discovered models, switches `model`
  and `small_model`, and updates only the connector's provider-list membership.
  Existing providers and later unrelated list changes are retained.
- **Hermes:** `HERMES_HOME/config.yaml`; defaults to `~/.hermes` on POSIX and
  `%LOCALAPPDATA%/hermes` on Windows. Setup adds a named custom provider using
  `chat_completions`, authors its discovered model list, and selects
  `custom:copilot_api_connector`. Native `config check` runs without a chat.
- **OpenClaw:** `OPENCLAW_CONFIG_PATH`, otherwise
  `OPENCLAW_STATE_DIR/openclaw.json` or `~/.openclaw/openclaw.json`;
  `OPENCLAW_HOME` is respected. Setup merges a custom runtime provider,
  registers its discovered models and aliases, changes the default model, and
  adds an executable secret provider. Native `config validate --json` runs
  without activating the Gateway. Configurations using `$include` for managed
  settings must be consolidated first; the connector does not claim included
  files or bypass helper-path/ACL trust checks.

Directory overrides must be absolute (supported home/environment expansion is
applied where appropriate). JSON/JSONC/JSON5 source-range edits preserve
unrelated text and comments. Hermes uses YAML document edits that retain
comments and unrelated settings. Duplicate keys and incompatible parent
containers are rejected rather than guessed. Project, managed, inline or
agent-specific settings can still override these user-level settings.

## What Connect changes for Codex

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

The connector's copy of every gateway key is encrypted using Electron's
OS-protected `safeStorage` in its user-data directory. Codex, Claude Code,
Hermes and OpenClaw configurations contain credential-helper references, not
the key. Keys are never written to model catalogs or logs. Plaintext Linux backends and
unrecognized keychain backends are rejected; enable a supported system
keychain before connecting.

**OpenCode exception:** its normal provider configuration does not support
dynamic command-backed authentication. With your explicit consent, the
connector writes a readable key into its native provider configuration so
OpenCode can start normally, including outside the connector. This file and
transaction/recovery snapshots can contain the key: protect them, never
commit/share them, and use a revocable gateway key. Environment/file
placeholders are not encrypted credential stores. No equivalent plaintext
fallback is used for the other four harnesses.

Hermes uses the native per-provider `key_cmd`, not its unrelated POSIX-only
startup dotenv helper. OpenClaw uses its documented **single-ID executable
provider** with `jsonOnly: false`: the connector emits a JSON-quoted string
containing that profile's key. This also handles numeric-looking keys without
mistaking them for a JSON number. The native resolver associates it with the
single `gateway-api-key` reference; multi-ID requests are not supported.
No stdin parsing is needed, avoiding Electron GUI executable stdin limitations
on Windows. Its child environment receives the
needed OS profile/keychain variables, not the API key. OpenClaw resolves
secrets into a runtime snapshot: **reload/restart its Gateway after key rotation**.

Existing Codex installations retain their original root data filenames,
encrypted key, helper arguments and Undo baseline. Additional harnesses live
in separate `connections/<harness>` directories but share the same Chromium
encryption profile. Do not relocate those directories or use a per-harness
Chromium profile.

Codex invokes the installed connector executable as a short-lived credential
helper. Its stdout carries the token directly to Codex. Closing the connector
window does not break authentication. Keep it installed and do not move its
executable or Linux AppImage after configuration; reconnect if its path changes.
Setup preflights that helper before launching Codex, so keychain or helper
failures are reported without waiting for Codex authentication retries.

On Windows, startup initializes and persists the shared Chromium encryption
profile before the GUI loads it. The GUI and helper use the same session-data
directory, and helpers shut down gracefully to persist encryption metadata.
This prevents a fresh-profile race where the GUI can encrypt a key but a
separate helper cannot decrypt it.

If Codex reports a credential-helper decryption failure, it failed before
authenticating to the gateway; visible models do not prove that authentication
works. Install the corrected connector build, reopen it under the same Windows
account, enter the URL and gateway key again, and click **Connect Codex**. Then
restart Codex. Do not delete your Codex configuration or copy encrypted
credentials between Windows users or machines. If the old encryption metadata
was lost, the original ciphertext cannot be recovered; reconnecting replaces
the saved key while preserving the connector's existing Undo history.

For Codex, Connect and Sync perform two small inference checks:

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

For the other four harnesses, Connect/Sync perform **one protocol-specific
streaming synthetic tool-call check**: Messages must close the tool block and
message with `tool_use`; Chat Completions must finish `tool_calls` and emit
`[DONE]`. Fragmented function arguments are validated in their native shape.
Credential helpers are preflighted where supported. This verifies gateway
transport and the generated configuration, **not a full native agent chat**;
user tools, plugins and personal agent sessions are not invoked for validation.

## Sync, key rotation, and Undo

- Saved keys stay out of the renderer until **Show key** is clicked. It reveals
  the selected connection's key (or the explicitly selected reused connection).
  **Hide key**, leaving the window, switching connections, and successful
  setup/Undo clear the revealed copy. Unsaved replacement keys are not discarded
  by Hide key. Nothing writes the revealed key to logs or browser storage.
- Reconnecting to the same saved URL can reuse its encrypted key without
  displaying it. Changing the URL requires an explicitly entered key or a
  matching saved connection; a saved key is never silently sent to another URL.
- **Sync models** reuses the encrypted saved key, updates the catalog, and
  verifies the existing selected model. A removed selected model requires an
  explicit replacement; the connector does not silently reroute requests.
- To change the tunnel URL or rotate the key, enter the new values and
  reconnect. The first pre-connector model settings remain available for Undo.
- **Undo connection** requires confirmation. Close the selected harness first.
  Connector-owned settings are removed and the original model settings are
  restored, while later unrelated edits are retained. The saved gateway key,
  catalog, and connection state are removed.

Writes are atomic and protected by a transaction journal and an exclusive
setup lock. Verification failure rolls back configuration, catalog, credential,
and state together. Startup recovers interrupted transactions and identifiable
dead-process locks. If files were edited externally during setup or recovery,
the connector refuses to overwrite those edits and retains the recovery
journal with an actionable error.

Connector-managed fields edited outside the app also block ordinary reconnect,
Sync, and Undo. Changing a model or its reasoning settings in the harness can
trigger this protection. **Repair connection**, followed by **Back up and
reconnect**, is the explicit recovery path: close the harness first, check the
form's URL/model and saved or replacement key, then confirm. Repair backs up
the current configuration before writing, reapplies only Connector-managed
settings, runs the normal verification, and preserves unrelated edits and the
first pre-Connector Undo baseline. Verification failure restores the current
configuration and retains the backup. Unknown provider ownership, invalid or
missing configuration, concurrent edits, and recovery-journal conflicts still
block repair; it is not a force-write option.

Backups are timestamped files under `config-backups` in that harness's private
Connector profile. On Windows, Codex uses
`%APPDATA%\Copilot API Connector\config-backups`; other harnesses use their own
subdirectory under `connections`. Backups can contain existing configuration
secrets, are retained through Undo, and must not be shared or committed.
Alternatively, restore the Connector-managed settings manually before Undo.
For ambiguous stale locks, the error identifies the
exact lock file that can be removed after closing the connector. Recovery data
can contain prior configuration secrets: keep the user-data directory private
and do not upload its contents when reporting a problem.

Undo before uninstalling. Uninstalling while connected leaves helper-backed
harnesses pointing at a missing executable.

## Supported environments

The connector has separate Windows NSIS, macOS DMG, and Linux AppImage packaging
with a distinct application ID and no gateway/server resources. Host and
connector applications can coexist. Release builds currently use the
repository's existing signing policy; automatic connector updates are not
implemented.

It configures harnesses in their **native OS environment**. A Windows connector does
not configure a separate WSL installation. Native desktop apps must be restarted
to load changes, and managed or project configuration can still override user
settings. The isolated smoke test proves the provider connection, not every
configuration layer of an existing session.

Custom-provider configuration is intended for installed local clients, not
hosted orchestration that disallows custom providers. The researched contracts
are from current official harness documentation/source; older versions may
lack the helper or named-provider fields and must be upgraded.

References: [Claude gateway configuration](https://code.claude.com/docs/en/llm-gateway),
[OpenCode providers](https://opencode.ai/docs/providers/),
[Hermes provider configuration](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/integrations/providers.md),
[OpenClaw custom providers](https://docs.openclaw.ai/concepts/model-providers),
and [OpenClaw secrets](https://docs.openclaw.ai/gateway/secrets).

## Build and validation

Run `bun install --frozen-lockfile` once at the repository root, then work from
`apps/connector`:

```sh
bun run dev
bun run gen-icons
bun run build
bun run package:win
bun run package:mac
bun run package:linux
```

Connector packaging does **not** run `build:server`. Output goes to
`apps/connector/release-connector`, separate from Gateway artifacts in
`apps/gateway/desktop/release`. The product-specific release workflows build
and upload only the selected product.

Focused tests:

```sh
bun test --coverage ./tests/connector.test.ts ./tests/connector-protocols.test.ts ./tests/connector-harnesses.test.ts ./tests/connector-ui.test.ts ./tests/connector-release.test.ts
bun run typecheck
```

The optional native integration test uses a local synthetic gateway and never
sends prompts to a real subscription. Set `CONNECTOR_TEST_CODEX` to an absolute
native Codex executable path, then run:

```sh
bun test ./tests/connector-integration.test.ts
```

To exercise actual OS encryption and the connector's credential helper as
well, build the connector and set `CONNECTOR_TEST_ELECTRON` to the development
Electron executable. Optionally set `CONNECTOR_TEST_HELPER` to the packaged
connector executable to test the shipped helper. These checks use isolated
temporary data and synthetic keys, not your real gateway or Codex settings.
Resolve the development runtime with `node -p "require('electron')"`; the
workspace hoists it rather than installing a separate copy in each app.

With `CONNECTOR_TEST_ELECTRON` set, the Windows storage lifecycle regression
also exercises first use while the real GUI remains open, app restarts, cached
session-data paths, and concurrent credential helpers:

```sh
bun test ./tests/connector-storage-integration.test.ts
```

Electron's standard `--user-data-dir=<absolute-path>` switch can isolate
connector data for development and testing. The generated helper configuration
keeps that path, so credential reads do not depend on a shell environment.
