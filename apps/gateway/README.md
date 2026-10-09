# Copilot API Gateway

Gateway signs in to Copilot or other providers and serves OpenAI- and
Anthropic-compatible APIs. Run it on the host machine; consumers use the
separate Connector with the host's URL and API key.

The API package and Electron desktop app share the Gateway version.
Gateway releases use `v<version>` tags, independently of Connector releases.

From the repository root:

```sh
bun install --frozen-lockfile
bun run dev start
bun run build
bun run build:gateway
bun run --cwd apps/gateway test
bun run --cwd apps/gateway/desktop test
```

The published CLI can be started with `npx @jeffreycao/copilot-api@latest start`.
For setup, supported providers, API authentication, and Docker usage, see the
[repository documentation](https://github.com/rajathnaik/Copilot-API#readme).
