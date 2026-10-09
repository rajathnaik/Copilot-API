# Repository Guidelines

## Project Layout

- `src/`: Bun/TypeScript API gateway; `routes/` handles HTTP endpoints, `services/` integrates providers, `lib/` holds shared logic, and `lib/types/` defines OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages contracts.
- `tests/`: gateway tests named after the features they cover; `pages/`: static web assets; `docs/`: documentation and screenshots; `plugin/`: plugin scripts.
- `desktop/`: Electron app with its own package, source, and checks; root ESLint excludes both `desktop/` and `plugin/`.

## Commands

Run from the repository root unless noted:

- `bun run dev` / `bun run start`: watch / production API entrypoint, with system CA enabled.
- `bun run build`: package build; `bun run build:desktop`: desktop server bundle.
- `bun run typecheck` / `bun run lint`: gateway TypeScript / ESLint checks.
- `bun run typecheck:all` / `bun run lint:all`: gateway and desktop checks.
- `bun test tests/provider-resolver.test.ts`: one test file; `bun test tests`: gateway suite; `bun test`: all discovered tests.
- `bun run --cwd desktop test`: desktop tests; `bun run --cwd desktop build`: Electron app build.

## Code Style

- Use ES modules, strict TypeScript, and `~/*` imports within `src/`; avoid `any` and derive request/response fields from actual contract types.
- Use `camelCase` for variables/functions, `PascalCase` for types/classes, and descriptive filenames such as `responses-stream-translation.ts`.
- Format gateway files with `bun run lint --fix <files>`; use the desktop package's lint configuration for desktop files.
- ESLint embeds Prettier options, including `semi: false`; do not run standalone `prettier` or `bunx prettier`.

## Verification

- Use Bun tests named `*.test.ts` in `tests/` or `desktop/tests/`, matching the affected package.
- Changed code must reach at least 80% unit test coverage; use `bun test --coverage <test-files>` to inspect coverage.
- Test affected request translation, providers, auth, config, and streaming edge cases; run the relevant tests, lint, and typecheck for code changes, expanding validation for shared behavior.
- For documentation-only changes, verify referenced paths/commands and inspect the diff; application tests are unnecessary.

## Security

Never commit tokens, local credentials, or generated secrets; carefully check auth, proxy, TLS, and token refresh changes, especially in `src/lib/`, `src/auth.ts`, and `src/services/github/`.

## Commits and Pull Requests

Use short, imperative Conventional Commit subjects such as `feat: support custom provider auth flow`; PRs should describe the resulting behavior, link relevant issues, list checks and results, and include screenshots for desktop/UI changes.

## Product Releases

- Gateway and Connector are independent products: keep their versions, release tags, builds, and installer assets separate.
- After a successful commit or push handled by the agent, ask whether the user wants a release. For a combined commit-and-push operation, ask once after the push. Propose the affected product and an appropriate patch/minor/major version.
- Commit/push approval is not release approval. Do not create release tags, publish releases, or upload installers without explicit approval for that product/version.
- Connector releases use `connector-v<version>`; existing Gateway releases use `v<version>`. Never use a Gateway tag to publish Connector installers, or mark a Connector release as the repository's global latest release.
- Release only tested source already pushed to the remote. Check that package metadata, tag, and actual installer versions match; verify the public download after publishing.
- Normal branch pushes may run checks but must not publish. The Connector publishing workflow accepts only an explicitly approved product tag or manual workflow dispatch.

## Learnings

- GitHub has one repository-wide latest release. Its `/releases/latest` endpoint can return the first stable Connector release even with `--latest=false`; that flag does not guarantee product filtering. The user approved keeping Connector stable with this fallback: share product-specific tag/asset links, and designate an approved Gateway release as latest when one exists.
