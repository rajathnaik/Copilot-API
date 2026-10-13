# ModelBridge repository guidelines

## Architecture

- This is a clean-slate rebuild. Do not restore the legacy Gateway/Connector
  shells, compatibility entry points, automatic state imports or old release
  workflows to accelerate implementation.
- Preserve the original direct Copilot device OAuth, token exchange, discovery
  and forwarding approach. Reuse its protocol translators; do not introduce
  the Copilot SDK or replace conversations with lossy prompt serialization.
- `apps/modelbridge/` owns Electron, IPC, protected-profile composition, UI,
  tray and external CLI processes. Its new app ID is
  `com.rajathnaik.modelbridge`; data defaults to `%APPDATA%\ModelBridge`.
- `packages/runtime/` owns source/model contracts, routing, authenticated
  gateways, credential abstractions and Dev Tunnels provisioning. It must
  not import Electron or application source.
- Source-qualified model IDs are explicit routes, not aliases that may fall
  back to another account/provider. Local and shared listeners use separate
  keys; only explicitly shared sources may be exposed remotely.
- Preserve Git history, published releases and unrelated user data. Replacement
  of the old local products is approved only after the unified installer is
  ready; use their exact uninstallers, not broad directory deletion.

## Validation

- Use one root `bun install --frozen-lockfile`, with Bun 1.4.2.
- Run `bun run lint:all`, `bun run typecheck:all`, `bun run test` and
  `bun run build`; run affected tests first during iteration.
- Tests live in their owning workspace's `tests/`. Never use a bare `tests`
  filter spanning workspaces.
- Changed production logic must have at least 80% line coverage. Exercise
  streaming, exact routes, credentials, source-sharing boundaries, restart
  persistence and tunnel failure paths, not only successful discovery.
- Native desktop tests use isolated temporary profiles and synthetic local
  providers. Never launch automated tests against real user profiles, modify
  real harness settings, provision live tunnels or print credentials.
- Use the owning ESLint configuration for formatting (no semicolons, single
  quotes in TypeScript). Keep strict types and explicit validation/errors.

## Product scope and releases

- `0.1.0-dev.0` is a development foundation, not a shipped universal product.
  Direct Copilot hosting and revision-safe Codex configuration are implemented
  with synthetic/native isolated checks. Do not claim real subscription,
  tunnel or two-machine acceptance before live verification. Other harnesses
  and subscription adapters remain subsequent milestones.
- Desktop and runtime are private workspaces of one product with matching
  versions, not independent installer products.
- No release/update publishing workflow is active during the rebuild. Future
  tags use `modelbridge-v<version>`, with explicit product/version approval,
  tested pushed source, installer/checksum and upgrade validation.
- Never force-push, replace historical tags, delete release assets or uninstall
  old apps merely as part of source restructuring.
- Retain LICENSE and NOTICE attribution and provider permitted-use boundaries.
  A consumer subscription does not automatically grant third-party API access.

## Learnings

- The Dev Tunnels SDK's MIT license does not license redistribution of the
  proprietary Microsoft CLI. Do not bundle or auto-download it; retain the
  manual Microsoft instructions/recheck flow, gate hosting with offline
  `--help` validation, and allow client-only installation without the CLI.
- A credential helper tested only after the desktop exits can pass while
  first-run concurrent retrieval fails. On fresh Windows profiles, this
  occurred with Electron safeStorage; retain profile-bound DPAPI CurrentUser
  protection and test applying Codex settings while the app is still running.
  Migration must preserve the existing local key, and credential-only mode
  should decrypt only that key, not unrelated subscription credentials.
