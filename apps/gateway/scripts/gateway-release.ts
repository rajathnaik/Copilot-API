import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

interface ReleaseSource {
  eventName?: string
  refType?: string
  refName?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function gatewayReleaseMetadata(
  gateway: unknown,
  desktop: unknown,
  source: ReleaseSource,
) {
  if (
    !isRecord(gateway)
    || gateway.name !== "copilot-api-gateway"
    || gateway.private !== true
    || !isRecord(desktop)
    || !isRecord(desktop.build)
    || desktop.build.appId !== "com.copilot-api.desktop"
  )
    throw new Error("Release metadata must belong to Copilot API Gateway.")
  const version = gateway.version
  if (
    typeof version !== "string"
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)
    || desktop.version !== version
  )
    throw new Error("Gateway API and desktop require matching stable versions.")
  const tag = `v${version}`
  if (
    source.eventName !== "push"
    || source.refType !== "tag"
    || source.refName !== tag
  )
    throw new Error("Only a matching approved Gateway tag can publish.")
  return { version, tag }
}

export function writeGatewayReleaseOutputs(env: NodeJS.ProcessEnv): void {
  const metadata = gatewayReleaseMetadata(
    JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ),
    JSON.parse(
      fs.readFileSync(
        new URL("../desktop/package.json", import.meta.url),
        "utf8",
      ),
    ),
    {
      eventName: env.GITHUB_EVENT_NAME,
      refType: env.GITHUB_REF_TYPE,
      refName: env.GITHUB_REF_NAME,
    },
  )
  if (!env.GITHUB_OUTPUT)
    throw new Error("GitHub Actions output path is required.")
  fs.appendFileSync(
    env.GITHUB_OUTPUT,
    `version=${metadata.version}\ntag=${metadata.tag}\n`,
  )
  console.log(
    `Validated Copilot API Gateway ${metadata.version} (${metadata.tag}).`,
  )
}

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  writeGatewayReleaseOutputs(process.env)
