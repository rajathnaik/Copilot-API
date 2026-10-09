# Repository Guidelines

## Project Layout

- `apps/gateway/`: private Bun/TypeScript Gateway package, with `src/`, `tests/`, and `pages/`; `src/lib/types/` defines the protocol contracts. Its Electron app is under `desktop/`, with its own manifest and checks.
- `apps/connector/`: standalone consumer Electron app, with its own manifest, version, harness configurations, tests, and installer settings. It must not import Gateway source.
- `packages/shared/`: private, genuinely shared atomic file writing, typed English strings, theme preference, and styling. Bundle this package into distributed artifacts. Both desktop products are English-only; do not restore language selectors or system-language detection.
- `tests/`: workspace architecture tests; `scripts/`: shared build/development tools; `docs/`: documentation and screenshots; `plugin/`: Gateway plugin scripts.
- Root is a private Bun workspace with one hoisted lockfile/install. Keep `docker-compose.yaml` at root so existing relative data mounts remain unchanged.

## Commands

Run from the repository root unless noted:

- `bun run dev` / `bun run start`: watch / production API entrypoint, with system CA enabled.
- `bun install --frozen-lockfile`: install all workspaces; do not perform separate desktop installs.
- `bun run build`: Gateway API bundle; `bun run build:desktop`: Gateway server bundle; `bun run build:gateway`: Gateway server and Electron app; `bun run build:connector`: Connector Electron app.
- `bun run typecheck` / `bun run lint`: root tooling (and Gateway API for typecheck).
- `bun run typecheck:all` / `bun run lint:all`: all workspaces.
- `bun run test`: all suites with their correct working directories and test setup.
- `bun run knip`: workspace-aware inventory; verify ownership, internal use and runtime entrypoints before removing flagged exports or dependencies.
- From `apps/gateway/`, `bun test ./tests/provider-resolver.test.ts`: one Gateway test; `bun run test`: its suite.
- `bun run --cwd apps/gateway/desktop test` / `bun run --cwd apps/connector test`: individual Electron suites.
- Use explicit `./tests` directories, not the bare `tests` filter, which discovers nested workspaces and bypasses their working-directory assumptions.

## Code Style

- Use ES modules, strict TypeScript, and `~/*` imports within Gateway `src/`; avoid `any` and derive request/response fields from actual contract types.
- Use `camelCase` for variables/functions, `PascalCase` for types/classes, and descriptive filenames such as `responses-stream-translation.ts`.
- Format files using the owning package's ESLint configuration; from that package run `bun run lint --fix <files>`.
- ESLint embeds Prettier options, including `semi: false`; do not run standalone `prettier` or `bunx prettier`.

## Verification

- Use Bun tests named `*.test.ts` in the owning workspace's `tests/`.
- Changed code must reach at least 80% unit test coverage; run `bun test --coverage ./tests/<file>.test.ts` from the owning workspace.
- Test affected request translation, providers, auth, config, and streaming edge cases; run the relevant tests, lint, and typecheck for code changes, expanding validation for shared behavior.
- For documentation-only changes, verify referenced paths/commands and inspect the diff; application tests are unnecessary.

## Security

Never commit tokens, local credentials, or generated secrets; carefully check Gateway auth, proxy, TLS, and token refresh changes, especially in `apps/gateway/src/lib/`, `apps/gateway/src/auth.ts`, and `apps/gateway/src/services/github/`, and Connector credential helpers.

## Commits and Pull Requests

Use short, imperative Conventional Commit subjects such as `feat: support custom provider auth flow`; PRs should describe the resulting behavior, link relevant issues, list checks and results, and include screenshots for desktop/UI changes.

## Product Releases

- Gateway and Connector are independent products: keep their versions, release tags, builds, and installer assets separate.
- Gateway versions live in `apps/gateway/package.json` and `apps/gateway/desktop/package.json` and must match. Connector version lives only in `apps/connector/package.json`. Preserve installed app identities and saved-data locations when reorganizing source.
- After a successful commit or push handled by the agent, ask whether the user wants a release. For a combined commit-and-push operation, ask once after the push. Propose the affected product and an appropriate patch/minor/major version.
- Commit/push approval is not release approval. Do not create release tags, publish releases, or upload installers without explicit approval for that product/version.
- Connector releases use `connector-v<version>`; existing Gateway releases use `v<version>`. Never use a Gateway tag to publish Connector installers, or mark a Connector release as the repository's global latest release.
- Release only tested source already pushed to the remote. Check that package metadata, tag, and actual installer versions match; verify the public download after publishing.
- Normal branch pushes may run checks but must not publish. The Connector publishing workflow accepts only an explicitly approved product tag or manual workflow dispatch.
- Gateway installer publishing is self-contained and targets this fork. Do not restore upstream npm, container-registry or GitHub Pages publication. Docker Compose builds the local fork image; keep the runtime usage page and functional plugins.

## Learnings

- Regenerate consolidated lockfiles with Bun, not by merging package records: identical record keys can hide incompatible transitive versions (for example `signal-exit` 3 vs 4). Remove stale per-workspace install shims when changing linker layouts, and verify a frozen install plus actual packaging.
- Electron Builder needs an exact Electron version when dependencies are hoisted outside the product directory; keep both Electron manifests pinned consistently. The shared lint toolchain pins the original Gateway formatter/TypeScript-ESLint versions to avoid unrelated source/style changes.
- Preserve each product's Node/Bun declaration versions explicitly during workspace migration. Hoisting newer Node declarations can change error and mock inference; validate typing before applying lint autofixes that may remove necessary type assertions.
- GitHub has one repository-wide latest release. Its `/releases/latest` endpoint can return the first stable Connector release even with `--latest=false`; that flag does not guarantee product filtering. The user approved keeping Connector stable with this fallback: share product-specific tag/asset links, and designate an approved Gateway release as latest when one exists.
