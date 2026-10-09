import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

interface ReleaseSource {
  eventName?: string
  refType?: string
  refName?: string
  requestedVersion?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function connectorReleaseMetadata(
  config: unknown,
  source: ReleaseSource,
) {
  if (
    !isRecord(config)
    || config.appId !== 'com.copilot-api.connector'
    || !isRecord(config.extraMetadata)
    || config.extraMetadata.name !== 'copilot-api-connector'
  )
    throw new Error('Release metadata must belong to Copilot API Connector.')
  const version = config.extraMetadata.version
  if (
    typeof version !== 'string'
    || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)
  )
    throw new Error(
      'Connector releases require an explicit stable semantic version.',
    )
  const tag = `connector-v${version}`
  if (source.eventName === 'push') {
    if (source.refType !== 'tag' || source.refName !== tag)
      throw new Error('Approved Connector tag does not match package version.')
  } else if (source.eventName === 'workflow_dispatch') {
    if (source.requestedVersion !== version)
      throw new Error(
        'Approved manual release version does not match package version.',
      )
  } else {
    throw new Error('Only product-tag pushes or manual dispatches can publish.')
  }
  return { version, tag }
}

export function writeConnectorReleaseOutputs(env: NodeJS.ProcessEnv): void {
  const metadata = connectorReleaseMetadata(
    JSON.parse(
      fs.readFileSync(
        new URL('../connector-builder.json', import.meta.url),
        'utf8',
      ),
    ),
    {
      eventName: env.GITHUB_EVENT_NAME,
      refType: env.GITHUB_REF_TYPE,
      refName: env.GITHUB_REF_NAME,
      requestedVersion: env.INPUT_VERSION,
    },
  )
  if (!env.GITHUB_OUTPUT)
    throw new Error('GitHub Actions output path is required.')
  fs.appendFileSync(
    env.GITHUB_OUTPUT,
    `version=${metadata.version}\ntag=${metadata.tag}\n`,
  )
  console.log(
    `Validated Copilot API Connector ${metadata.version} (${metadata.tag}).`,
  )
}

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  writeConnectorReleaseOutputs(process.env)
