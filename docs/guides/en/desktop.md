# Desktop App

[Home](../../../README.md) · [Documentation](README.md)

## Electron Desktop App

This is the **host** application. Consumers connecting to its remote tunnel use
the separate [Copilot API Connector](connector.md); they do not need to install
this gateway or sign in to Copilot.

If you prefer a GUI, this repository also includes an Electron desktop app in `apps/gateway/desktop/`. It supports GitHub Copilot sign-in, OpenAI Codex OAuth with manual switching among up to 3 Codex accounts and removal of accounts that are not in use, and API-key configuration for Kimi, DeepSeek, DashScope, OpenRouter, or a custom provider. Provider configuration, server API keys, and account changes automatically refresh the running service; new requests use the updated configuration. After authorization or provider configuration, it can start and stop the local proxy with one click and shows the local endpoint, auth header, available models, usage, and logs in the app.

Listening host, proxy, verbose logging, and token logging are server startup options. Saving changes automatically restarts a running service and may interrupt active requests. OAuth App, API Home, SQLite DB Path, and Enterprise URL still require restarting the desktop app. Saving while the service is stopped does not start it.

Retrying GitHub sign-in supersedes the previous attempt, including token finalization. A superseded attempt cannot report success or overwrite a newer completed sign-in.

The app is English-only, including menus, dialogs and notifications. Existing
saved language preferences are ignored without resetting sign-in, API keys,
theme, proxy, storage paths or startup settings.

The settings screen also exposes `OAuth App`, `API Home`, `SQLite DB Path`,
`Enterprise URL`, verbose logging, and minimize-to-tray.
[Gateway 2.7.1](https://github.com/rajathnaik/Copilot-API/releases/tag/v2.7.1)
provides Windows x64 (`.exe`), macOS Apple Silicon (`.dmg`) and Linux x64
(`.AppImage`) installers with SHA256 checksums. On Windows, use
[Copilot.API.Setup.2.7.1.exe](https://github.com/rajathnaik/Copilot-API/releases/download/v2.7.1/Copilot.API.Setup.2.7.1.exe).
Connector releases are a different product; upstream installers do not include
this fork's changes.

On Linux, make the downloaded AppImage executable before launching it:

```sh
chmod +x Copilot-API-*-linux-x86_64.AppImage
./Copilot-API-*-linux-x86_64.AppImage
```

Download the installer for your platform, authorize or configure a provider inside the app, choose a port, start the server, then point your client at the local endpoint shown in the app. Packaged desktop builds use the bundled Electron runtime, so normal desktop usage does not require installing Node.js separately. Token usage history is enabled when that bundled runtime supports SQLite.

Packaged builds check this fork for stable Gateway updates 15 seconds after
launch and every 6 hours. Connector tags are not Gateway updates. You can also
use **Settings > Updates > Check for updates**. Windows NSIS and Linux AppImage
builds download updates when compatible updater metadata is available and
verify the installer against its SHA-512 checksum. Click **Restart and
install** when ready; installation stops the local API server and interrupts
active requests. Closing the app does not install a pending update.

macOS builds are unsigned and offer a link to download and manually install the new DMG. Linux builds launched outside an AppImage and older releases without updater metadata also use manual installation. Development builds do not check for updates. Update requests use the app's configured proxy.

The self-contained Gateway release workflow validates matching API/desktop
versions, builds installers, creates the product release and uploads checksums,
`latest.yml`, Windows `.blockmap` files and `latest-linux.yml`. It does not depend
on npm publication. Users of upstream builds must install this fork's build
once to switch update ownership. No GitHub token is needed on users' machines.

The desktop app's Advanced Config page reads and writes the shared model mappings through `GET/POST /admin/config/model-mappings`. The same mappings apply across `POST /v1/messages`, `POST /v1/messages/count_tokens`, `POST /v1/responses`, and `POST /v1/chat/completions` instead of being split per interface. It uses `auth.adminApiKey` instead of the regular `auth.apiKeys`, and the app reads that key directly from `config.json` after the server has generated it on startup.

### Windows workspace shortcut

From the repository root, install once with `bun install --frozen-lockfile`.
On Windows, run [launch-desktop.ps1](../../../launch-desktop.ps1); on any
supported development platform, run `bun run --cwd apps/gateway/desktop dev`.
See [source prerequisites](getting-started.md#prerequisites).

A **Copilot API** shortcut created for a local source checkout runs
[launch-desktop.ps1](../../../launch-desktop.ps1), not an installed Gateway
release. It requires the checkout and Bun, rebuilds stale bundles, and launches
the workspace Electron runtime. Fixes to that launcher take effect through the
existing shortcut without reinstalling or resetting saved sign-in data.

The standalone Gateway installer is separate and does not require the source
checkout or Bun.

### Application icon

The original robot artwork in `apps/gateway/desktop/assets/app-icon.svg` is shared by the
header and sign-in screen. Its generated PNG is the runtime window icon, and
`apps/gateway/desktop/build/icon.ico` supplies the Windows installer and executable icon.
The Windows/Linux tray uses small versions of the same artwork; macOS retains
its monochrome template tray icon.

To regenerate the PNG, tray images, and multi-resolution Windows ICO after
editing the SVG, install `rsvg-convert` from librsvg and run:

```sh
cd apps/gateway/desktop
bun run gen-icons
```

Commit the SVG and generated assets together. Restart the desktop app after
changing its window icon. Installed or pinned Windows shortcuts may retain a
cached icon until they are recreated or updated by a new installer.
