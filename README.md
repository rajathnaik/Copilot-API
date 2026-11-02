# ModelBridge

One desktop application for hosting a Copilot subscription and connecting
Codex to local or remote models. Host and client are roles within the same
installation, not separate Gateway and Connector products.
The new desktop structure retains the original Copilot API's direct
authentication, token exchange, forwarding and protocol translations.
**There is no Copilot SDK integration.**

**Development pre-release: 0.1.1**, the latest ModelBridge release.

Download the unsigned Windows installer from the
[ModelBridge 0.1.1 release](https://github.com/rajathnaik/Copilot-API/releases/tag/modelbridge-v0.1.1):

- [Windows installer](https://github.com/rajathnaik/Copilot-API/releases/download/modelbridge-v0.1.1/ModelBridge.Setup.0.1.1.exe)
- [SHA256 checksum](https://github.com/rajathnaik/Copilot-API/releases/download/modelbridge-v0.1.1/ModelBridge.Setup.0.1.1.exe.sha256)

Compare `Get-FileHash .\ModelBridge.Setup.0.1.1.exe -Algorithm SHA256`
with the downloaded checksum before running the installer. Windows may warn
about an unknown publisher because this development build is not code-signed.
Use the same installer on the host and client machines.

To build the unsigned Windows development installer locally, run
`bun run --cwd apps/modelbridge package:win`. Its output is
`apps/modelbridge/release/ModelBridge.Setup.0.1.1.exe`. This is a test
candidate, not a verified production release; installation/upgrade/uninstall
and the real two-machine acceptance test are still pending.

## What's new in 0.1.1

- **No more duplicated replies in the Codex desktop app.** Copilot gives a
  streamed reply a new encrypted id in every event, so Codex showed each message
  twice (once while streaming and once when it finished). The gateway now keeps
  the first id for every event of an item. Updating the host is enough; clients
  benefit without changes.

## What's new in 0.1.0

0.1.0 is the first ModelBridge release. It includes everything in this README,
including the changes from the earlier development builds listed below.

- **Manage hosts on clients.** The client **Connect** tab is now **Hosts**. Each
  connected host has a card with its URL, model count, connection status and
  last check, plus **Check connection**, **Edit** and **Remove…**.
- **Edit keeps Codex working.** Rename a host or change its URL or access key in
  place. A new URL or key is verified with the host before it is saved, and the
  connection keeps its identity, so Codex's `model = "<source>/<model>"` route
  stays valid.
- **No more duplicate hosts.** Adding a host URL that is already connected
  reconnects that host (new key, refreshed models) instead of adding a second
  copy. Existing duplicates are flagged with a **Duplicate** badge; keep the one
  marked **Used by Codex** and remove the other.
- **Safe removal.** **Remove…** asks for confirmation, deletes the saved key and
  warns when Codex currently uses a model from that host.
- **Codex model list check.** The Codex tab notes when ModelBridge's models no
  longer match the applied Codex model list (offering **Preview Codex update**)
  or when Codex's default model is no longer available.

## Introduced in development build dev.7

These changes are included in 0.1.0.

- **Claude tool-schema fix.** Anthropic models rejected Codex tools whose input
  schema uses `oneOf`, `anyOf` or `allOf` at the top level
  (`input_schema does not support oneOf, allOf, or anyOf at the top level`).
  ModelBridge now flattens such schemas into a single object schema (merging
  properties and noting the alternatives in the description) before forwarding
  them to Messages and chat-only models.
- **One source per Copilot account.** Signing in to Copilot again with the same
  GitHub account now renews the existing source instead of adding a second one,
  keeping its label, sharing and web-search choices. On startup, existing
  duplicate sources for the same account are merged automatically, so the model
  list no longer shows every model twice.
- **Prompts and follow-ups.** Each request is tagged as a **Prompt** (you sent
  it) or a **Follow-up** (the agent continued after tool output), together with
  the Copilot premium requests it used, based on each model's billing
  multiplier. Only prompts use premium requests; follow-ups and web searches do
  not. The dashboard shows both counts, which makes it possible to tell real
  duplicate requests from normal agent continuations.
- **Named client machines.** Each client reports a name (by default its computer
  name; change it under **Settings → Client machine name**). The name is
  informational only; it is not secret and grants no access.
- **Clients and premium-request limits (hosts).** **Client machines this
  month** lists each client's last activity, requests and premium requests.
  Under **Premium request limits** you can set a default monthly limit per
  client, per-client overrides (or exempt a client) and per-model limits. Limits
  only warn: clients near (80%) or over a limit are flagged, but requests are
  never blocked.
- **Tokens-per-day line chart** with token and date axes, switchable between
  **Total**, **By model** and, on hosts, **By client**.
- **Host setup** has a dedicated **Choose the models clients can use** step with
  the full model-access controls.
- The **Web search helper** (formerly Web search model) is now labelled as what
  it is: the GPT model that runs web searches for Claude and other non-GPT
  models. It is not a default model.

## Introduced in development build dev.6

These changes are included in 0.1.0.

- Copilot discovery and inference now advertise the original Gateway's
  `vscode/1.139.1` compatibility version instead of the unsupported `1.109.0`.
  This addresses the reported HTTP 466 requirement for `1.109.2+`. The value
  belongs to ModelBridge's outgoing requests: updating locally installed VS Code
  does not change it. Live subscription inference still requires verification.
- **Models** (formerly Sources & models) lets you share all models or only
  selected models from each source. Expand **Model access** to choose a mode,
  select all current models, clear the selection, filter, or toggle individual
  models. The Host setup tab shows the shared-model count and links to these
  controls.

The policy applies to **all clients using the existing host key**. It restricts
both model catalogs and direct inference routes, so knowing a hidden model's ID
does not grant access. Local host tools retain access to every discovered model.
Changes affect new requests immediately; they do not cancel requests already
forwarded upstream. A client's cached catalog or Codex configuration may still
show a revoked model, but the host rejects its requests until access is restored
or another allowed model is chosen.

**All models** includes future discoveries automatically. **Only selected
models** retains the selection across restarts and refreshes; newly discovered
models remain private. An empty selection shares no models from that source.
Pausing **Share remotely** preserves the selection. Existing profiles without a
selection retain their previous all-model behavior. Each source's summary and
the model table show the effective remote access.

### Full model capabilities in every harness

Web search now works for every Copilot model, not only GPT models:

- **GPT models** (served by Copilot's Responses API) keep using Copilot's own
  hosted `web_search` tool unchanged.
- **Claude and other Messages/chat-only models** cannot use that hosted tool, so
  ModelBridge offers them an equivalent `web_search` function. When the model
  calls it, the host runs the query on a GPT model through Copilot's hosted web
  search, returns the answer with its source list to the model, and continues the
  turn. Codex sees standard `web_search_call` items with the query and sources.
  When the model also requests client tools in the same turn, the response ends
  after the searches so Codex can run those tools; the search results are kept
  on the host for 24 hours (up to 500) so replayed history stays complete.
- Each turn allows up to 8 searches. Each search and each continuation request
  gets its own 120-second limit, so a multi-step search turn is not cut short.
  A failed or timed-out search is reported to the model as a failed
  `web_search_call` rather than ending the turn; a failure while continuing
  after a search fails the response explicitly. The reported token usage is the
  final request's, which matches the conversation's real context size.
- **Models** shows a **Web search helper** for each Copilot source.
  **Auto** uses the newest full-size GPT model available (mini, nano and codex
  variants only when nothing else exists); you can pin a specific model instead.
  Searches run on the host, so the search model does not need to be shared with
  clients, and they count against the same Copilot subscription.

Codex catalogs also gained parity with the original Gateway: Codex-native
instructions (switching to compact instructions for every model, rather than
dropping models, when the catalog would exceed 1 MiB), discovered image input,
reasoning summaries, parallel tool calls, maximum output tokens and freeform
`apply_patch`. These capabilities are preserved across a remote host hop.
Before forwarding, the host removes tools Copilot rejects (`image_generation`),
strips client-only metadata, normalizes invalid image detail values and replaces
images larger than the model's advertised limit with a short note.

Live verification against a real subscription is still pending for the proxied
search path.

### Usage dashboard and host/client roles

The original Gateway's visibility is back, in the same app:

- **Roles.** On first start ModelBridge asks how this machine is used:
  **Host** (shares a Copilot subscription) or **Client** (uses another host).
  Existing installations pick their role from what is already set up. Switch at
  any time from the header or **Settings**; switching only changes the layout,
  never sign-ins, sources or sharing.
- **Focused tabs.** Host: Dashboard, Host setup, Models, Codex, Settings.
  Client: Dashboard, Connect, Models, Codex, Settings. Sharing controls appear
  only for hosts. The local gateway URL and key moved to **Settings**.
- **Dashboard.** Requests, failures, web searches, input/cached/output/reasoning
  tokens, estimated cost and average time for today, 7, 30 or 90 days, plus a
  tokens-per-day chart, a per-model breakdown, recent requests and, on hosts, a
  split between this machine and remote clients.
- **Copilot quota (hosts).** Premium-request, chat and completion allowances,
  remaining amounts, plan, account and reset date from GitHub's Copilot account
  endpoint, refreshed every minute while the dashboard is open or on demand.

Accounting is per upstream request, so a web search or a tool-continuation round
that ModelBridge sends on your behalf is counted exactly once with its own
tokens, rather than hidden inside the client's turn. Requests whose provider
reported no token counts are shown as such, never as zero-cost usage.
**Estimated cost** uses the AI units Copilot reports with each response
(`copilot_usage.total_nano_aiu`), converted at the original Gateway's rate of
100 AI units per US dollar; requests without reported AI units are not priced
and the dashboard shows how many were. It is an estimate, separate from your
subscription's quota and from GitHub billing. A client records the usage of its
own requests; it shows cost only when its host passes Copilot's AI units
through.

Usage history holds metadata only (time, source, model, token counts, status,
duration and reported AI units, never prompts or responses). It is kept in
monthly files under `%APPDATA%\ModelBridge\usage`, retained for about 13
months, and can be deleted from **Settings**. The live Copilot quota response
and the presence of AI units in live responses still need verification against
a real subscription.

## Current implementation

- One Electron desktop application with its own Windows identity:
  `com.rajathnaik.modelbridge`.
- A local, authenticated gateway on `127.0.0.1:4321`.
- GitHub device-code sign-in for Copilot, subscription model discovery,
  short-lived Copilot token refresh, and forwarding to the account's service
  endpoint. Native Responses models and the inherited Messages/Chat
  Completions translators expose a Responses interface for Codex.
- API-source discovery and native Responses, Messages, and Chat Completions
  forwarding. Select the protocol the provider actually supports.
- Remote ModelBridge sources, source-qualified model IDs, and explicit
  routing. No silent fallback to another source, account, or paid API.
- An authenticated Codex-native catalog at `/v1/codex/models`, separate from
  OpenAI-style `/v1/models`. It exposes Responses models only, includes the
  required model instructions, preserves explicit tool/context capabilities
  across remote hops, supports ETag refresh, and enforces Codex's 1 MiB limit.
- Independently selected sources and models for sharing through a separate
  authenticated listener on `127.0.0.1:4322`.
- Credentials (access keys and the Copilot sign-in token) are stored
  **unencrypted** in `%APPDATA%\ModelBridge\credentials.json`, protected only
  by your Windows user account. This is a deliberate simplification for a
  personal tool; at-rest encryption is deferred. Codex obtains its local key by
  running the same installed ModelBridge executable in credential-only mode,
  so the key is still never written into Codex's TOML.
  There is no automatic import of old product settings. A profile encrypted by
  0.1.0-dev.0/dev.1 is archived to a `legacy-encrypted-*` folder on first start;
  the tunnel ID (and therefore the URL) is kept, but you must sign in to Copilot
  again and re-apply the Codex configuration.
- The window opens immediately and shows a startup state while the runtime
  starts. It is organized into role-specific tabs (see "Usage dashboard and
  host/client roles").
- Codex installation discovery, redacted configuration previews, named
  revisions, reactivation, native configuration restoration, external-edit
  detection and recovery of interrupted configuration writes.
- Microsoft Dev Tunnels provisioning and hosting with a persistent,
  installation-specific tunnel ID.
- Tray operation: closing the window keeps the local runtime available.
- English-only application and packaged Electron resources.

## Windows installation prerequisites

The installer asks how you intend to use this machine:

- **Use as a host:** a working Microsoft Dev Tunnels CLI is required before
  installation can proceed. Open the linked Microsoft installation instructions,
  install the CLI yourself (for example, `winget install Microsoft.devtunnel`),
  then click **Recheck** without closing the wizard.
- **Client-only for now:** no Dev Tunnels CLI is required. Add the remote host
  URL and access key in ModelBridge. You can install the CLI later if this
  machine should also host.

This choice checks prerequisites; it does not permanently restrict the app's
role. The installer validates the CLI offline using `--help`, not a sign-in or
live tunnel. Detection includes PATH, updated user/system registry PATH and
the standard user/machine WinGet links/package locations. No global PATH is
modified, no CLI is downloaded/bundled/upgraded, and Microsoft's terms must be
accepted separately. The CLI is proprietary software, not covered by the
MIT license of Microsoft's tunnel SDK.

Unattended installation (`/S`) defaults to client-only. Use `/S /HOST` to require
the host prerequisite; a missing/invalid CLI exits with code **2** before
installing ModelBridge. Successful CLI detection does not replace Microsoft
sign-in or verify subscription/tunnel connectivity.

Electron and its Node runtime are bundled. Bun is only a development/build
prerequisite. The app uses Windows PowerShell only asynchronously, to refresh
PATH when looking for the Dev Tunnels and Codex CLIs.

When you click **Install**, the installer checks whether ModelBridge is
already running using an in-process lookup (`nsProcess`). The stock
electron-builder check shells out to PowerShell/WMI without a timeout and could
hang indefinitely on machines where PowerShell or WMI is slow or held by
security software; ModelBridge overrides it in both the installer and
uninstaller.

Source discovery is not inference verification. Generic API and remote
sources forward their advertised protocol; Copilot has its own inherited
cross-protocol adapters. Some provider APIs require dedicated discovery
adapters or pagination; the generic source integration does not claim support
for every provider.

## Troubleshooting installation

The installer cannot write a log file: electron-builder ships NSIS without
logging support. If the wizard freezes, note the last page shown and check
Task Manager for a `ModelBridge.Setup…` process at constant CPU (a script loop)
versus child processes such as `powershell.exe` or `devtunnel.exe` (a waiting
external command). Builds before 0.1.0-dev.3 froze on entering the
prerequisite page when the user PATH did not end with `;`.

## Troubleshooting startup

ModelBridge writes a non-secret diagnostics log to
`%APPDATA%\ModelBridge\logs\modelbridge.log` (rotated at 512 KB). It records
startup timings, window responsiveness and renderer/child-process failures; it
never records keys or tokens. If the window stays on "Starting ModelBridge…" or
startup fails, check this file first. ModelBridge is single-instance: launching
it again focuses the running window, including one hidden in the tray.

## Pending live verification and subsequent work

Real Copilot subscription inference through a live Dev Tunnel on two machines
has not yet been verified. Automated tests use synthetic providers and
isolated profiles, not a real subscription. Claude Code/OpenCode/Hermes/OpenClaw
discovery and setup, other subscription providers, account-specific allowances,
per-consumer remote keys, key rotation controls, and release/update automation
remain subsequent implementation milestones. Claude subscription integration
requires a separate feasibility and permitted-use assessment.

The development installer has been built and its unpacked executable has been
smoke-tested outside the workspace, including helper key retrieval while
the app runs, authenticated inference and packaged attribution. The prerequisite wizard has been tested with isolated missing/invalid/working
CLI fixtures and the full installer has been opened and cancelled before
installation, including detection of this host's installed CLI. An isolated variant of the
installer (different app ID/product name) has been silently installed,
reinstalled over a running app, and uninstalled without starting PowerShell;
upgrading a real dev.0/dev.1 installation still runs that build's old
uninstaller, which uses the stock PowerShell check. Existing
installations and historical Git/releases have not been removed. Codex
configuration is modified only after approving an explicit preview.

## What changes in Codex

On the client, add the host URL and host access key in ModelBridge (**Hosts**
tab). It discovers
the host's shared models and exposes them through its own local gateway.
Discover the installed Codex, choose a model and configuration name, and use
**Preview exact Codex changes** before applying.

ModelBridge edits the user-level `CODEX_HOME\config.toml` (normally
`%USERPROFILE%\.codex\config.toml`):

- `model_provider = "modelbridge"` selects the custom provider.
- `model` selects an exact source-qualified route, not a ChatGPT model alias.
- `[model_providers.modelbridge]` points `base_url` to the local `/v1` gateway,
  uses `wire_api = "responses"`, disables OpenAI authentication and websockets,
  and identifies the authenticated native model catalog URL.
- `model_catalog_json` points to a model-metadata snapshot, allowing Codex's
  picker to discover these models at startup.
- The provider's `auth.command` runs ModelBridge in credential-only mode with
  the explicit ModelBridge profile path. Its stdout is the local key, not a
  JSON envelope. Neither the host key nor Copilot token is stored in Codex.
- Reasoning/context settings are adjusted to the selected model's advertised
  capabilities. Unrelated TOML settings/comments are preserved.

The preview shows the current and proposed TOML with secrets redacted.
Revisions and the original managed settings are stored in ModelBridge's
profile. Restore native settings returns the owned fields/provider to their
original values while preserving later unrelated edits. External changes to
managed fields require explicit acknowledgement instead of being overwritten.
The app does not edit Codex's `auth.json`, sign you out, or add entitlement to
your ChatGPT subscription. Project/profile/CLI/managed settings can override
user-level configuration; restart Codex and start a new local chat after
switching because existing threads can retain their provider.

## How remote URLs work

ModelBridge does not invent a public hostname. On explicit **Enable remote
access**, it asks the Microsoft Dev Tunnels CLI to create or reuse its owned
persistent tunnel, registers the sharing port, and starts a host process.
Microsoft assigns the HTTPS URL; ModelBridge reads the sharing port's address
from `devtunnel host` output and waits for **Ready to accept connections**.
The CLI's `show` and `port show` metadata may omit public URLs, even when the
port is configured correctly; a missing metadata URL is not a sign-in failure.
Both a validated HTTPS URL for the sharing port and the ready signal are
required before ModelBridge reports sharing as active. It never constructs
a hostname from the tunnel ID or displays an inspection URL as the API URL.
The URL is reusable while the tunnel identity and port remain valid, but it is
not guaranteed permanent if the service resource expires or is recreated.

The relay permits anonymous transport access so a consumer only needs the host
URL and **ModelBridge host access key**. That does not mean the API is
unauthenticated. Local-client and remote-host keys are separate, and the
remote listener exposes only sources explicitly selected for sharing.

The host needs Microsoft's separately installed CLI and a one-time Dev Tunnels
sign-in. Dev Tunnels accepts a **GitHub account** (for example, the one you use
for Copilot; `devtunnel user login -g -d`) or a **Microsoft account**
(`devtunnel user login -d`). ModelBridge shows the account the CLI is already
signed in with (`devtunnel user show`), so you only sign in again to switch
accounts or after the CLI's sign-in expires. This sign-in only lets the host
own the tunnel; it is separate from the Copilot sign-in, and clients never sign
in to Dev Tunnels.

The host shows **Waiting for approval...**, **Checking sign-in...**, then a
disabled **Signed in** button with the account name and provider. The CLI
reports device-login completion; ModelBridge then runs `devtunnel user show`
to verify it. No browser callback URL is required. The UI refreshes every two
seconds. **I've signed in - check status** (or **Check sign-in status**) repeats
that verification manually, including after signing in outside the app. It
does not assume success from the button click. A failed check displays the
error rather than claiming the account is signed out or signed in. Signing in
does not start sharing: **Enable remote access** remains a separate action.
Copilot also uses device authorization: ModelBridge polls for approval and
confirms **Signed in** after saving the connection and discovering models.

```mermaid
flowchart TD
  Host[Host: ModelBridge] --> Copilot[Authorize GitHub Copilot]
  Copilot --> Poll[ModelBridge checks device approval]
  Poll --> Models[Copilot connection saved and models discovered]
  Host --> Account{Dev Tunnels account already signed in?}
  Account -->|Yes| Verified[Verify with devtunnel user show]
  Account -->|No| Choice[Choose GitHub OR Microsoft, not both]
  Choice --> Browser[Approve device code in browser]
  Browser --> CLI[CLI reports login completion]
  CLI --> Verified
  Manual[I've signed in - check status] --> Verified
  Verified -->|Account confirmed| Signed[Show Signed in and account identity]
  Verified -->|Not signed in or check failed| Retry[Show waiting, signed-out status or error; retry]
  Models --> Share[Click Enable remote access]
  Signed --> Share
  Share --> Tunnel[Reuse this installation's tunnel; start hosting]
  Tunnel --> Client[Client: paste host URL and access key; configure Codex]
```

The same GitHub account can perform both authorizations, but they grant access
to different services and use separate credentials. A Microsoft account is
optional, not an additional requirement. Signing in to Dev Tunnels alone does
not grant access to Copilot or confirm that sharing is running.

The installer's host prerequisite page checks the CLI and links to manual
installation instructions; ModelBridge offers device-code sign-in but does not
install software automatically. The client does not need this CLI. Both the
ModelBridge runtime and tunnel-host process must remain running.
[Microsoft's CLI reference](https://learn.microsoft.com/azure/developer/dev-tunnels/cli-commands)
describes provisioning, access controls, and service limitations. Dev Tunnels
is a preview service without a production SLA.

## Development

Requires Bun 1.4.2 and Node 22.18+; Windows is the first validated desktop
platform. Electron is pinned to 43.4.1.

```sh
bun install --frozen-lockfile
bun run dev
bun run build
bun run lint:all
bun run typecheck:all
bun run test
```

`MODELBRIDGE_PORT` overrides the local port; `0` selects an ephemeral port for
tests. Sharing uses port 4322. The desktop defaults to
`%APPDATA%\ModelBridge`; `--user-data-dir` explicitly selects an isolated
profile. `credentials.json` holds keys in plain text; do not share or commit it.

Missing or corrupt profile metadata/credentials are explicit failures, not
permission to silently regenerate keys. Preserve the affected profile for
recovery, or choose a fresh isolated profile for a new setup.
Interactive profile recovery is a later milestone.

The Windows native restart test uses a temporary Electron application/profile
and a synthetic provider. After building, run it from PowerShell:

```powershell
node .\scripts\ensure-electron.mjs
if ($LASTEXITCODE -ne 0) { throw 'Electron binary initialization failed.' }
$env:MODELBRIDGE_TEST_ELECTRON = node -p "require('electron')"
Set-Location apps\modelbridge
bun test .\tests\native-profile.test.ts
```

It verifies authenticated inference, credential storage, the actual
credential-only executable mode and stable local-key hashes across two
graceful application launches. It never provisions live
tunnels or modifies existing user profiles.
With `MODELBRIDGE_TEST_CODEX` also set, it clicks the real desktop's discovery,
preview, apply and restore controls, exercises revision reactivation, and
checks that the synthetic native account remains unchanged. Applying also
checks the helper while the app is still running, including a fresh profile.

To repeat the packaged-runtime test, set `MODELBRIDGE_TEST_PACKAGED_EXE` to the
build's `release\win-unpacked\ModelBridge.exe` and run
`bun test .\apps\modelbridge\tests\packaged-profile.test.ts` from the repository
root. It uses synthetic credentials and temporary ModelBridge/Codex profiles;
it does not install the app or modify existing user profiles.

The installer prerequisite tests are also opt-in. After packaging, point
`MODELBRIDGE_TEST_NSIS` at the cached NSIS `makensis.exe` and
`MODELBRIDGE_TEST_INSTALLER_EXE` at the built installer, then run
`bun test .\apps\modelbridge\tests\installer-prerequisites.test.ts`.
The native harness checks missing/invalid/working CLI handling, host/client
gating, recheck, cancellation and unattended exit codes using temporary
fixtures. The full wizard test opens the actual installer and cancels before
installation; it never clicks Install. Set `MODELBRIDGE_TEST_EXPECT_CLI=1`
on a known-ready host to require successful real CLI detection too.
This does not prove actual installation, upgrade or uninstall.

### Codex compatibility proof

Validated against the installed Windows desktop package **26.1002.7124.0**
and its bundled **codex-cli 0.162.0-alpha.2**:

- Actual app-server `model/list` discovers the source-qualified catalog.
- Complete Responses streams route two distinct models through an authenticated
  synthetic Copilot service -> sharing gateway -> consumer gateway -> Codex.
  The repeatable backend test covers native Responses plus inherited
  Messages and Chat Completions adapters.
- Codex executes an offered, harmless `exec_command` on the consumer and returns
  its matching `function_call_output`; the provider then completes the reply.
- Separate native desktop inspection confirmed that its picker displays both
  models as enabled options, and
  selecting the second updates its active model label.
- A synthetic native-account fixture remains byte-for-byte unchanged. These
  tests never read, copy, or edit a real account or harness profile.
- The backend/tool test uses the actual managed TOML/catalog and command-auth
  contract, then restores the synthetic native configuration.

The repeatable opt-in backend/tool test requires a separately installed Codex
console CLI.

```powershell
$env:MODELBRIDGE_TEST_CODEX = 'C:\path\to\installed\resources\codex.exe'
bun test .\apps\modelbridge\tests\codex-compatibility.test.ts
```

The separate desktop inspection used an isolated `CODEX_HOME`, isolated
Electron user data, a loopback debugging endpoint, and synthetic credentials;
it did not submit a paid request. Native GUI automation is not yet a repeatable
regression check: this desktop build can launch different first-run onboarding
flows before reaching Codex. Its GUI executable is selected from the package
manifest, not inferred from a file named `Codex.exe`.
This proves compatibility for that version, not universal desktop support,
real subscription hosting or native sign-in preservation with a real account.
Those remain live smoke-test milestones. The native desktop's cloud-only features may still require its
original ChatGPT sign-in independently of a custom local provider.

## Source boundaries

| Location | Responsibility |
| --- | --- |
| [apps/modelbridge](apps/modelbridge/) | Desktop lifecycle, IPC, UI, profile composition, tray and CLI process management |
| [packages/runtime](packages/runtime/) | Validated source contracts, explicit routing, gateway authentication, streaming, credential storage abstraction and tunnel provisioning |
| [tests](tests/) | Product identity and architectural boundaries |
| [scripts](scripts/) | Electron bootstrap, lint conventions and ModelBridge icon generation |

The desktop bundles runtime and renderer dependencies at build time. Packaged
execution does not depend on workspace symlinks or TypeScript source files.

The inherited application shells, CLI, plugins, Docker setup, old guides and
legacy release workflows have been retired from the active source tree. They
remain available in Git history. No remote release assets or tags are deleted.
ModelBridge releases use `modelbridge-v<version>` and require explicit
approval of the product/version after validation.

[MIT license](LICENSE) · [Lineage and responsible use](NOTICE.md)
