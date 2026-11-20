import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'

export const releasesUrl =
  'https://api.github.com/repos/rajathnaik/Copilot-API/releases?per_page=30'
const tagPrefix = 'modelbridge-v'
const maxInstallerBytes = 1024 * 1024 * 1024

export interface AvailableUpdate {
  version: string
  tag: string
  prerelease: boolean
  publishedAt: string | null
  pageUrl: string
  installerUrl: string
  checksumUrl: string
  size: number
}

export interface UpdateState {
  phase:
    | 'idle'
    | 'checking'
    | 'current'
    | 'available'
    | 'downloading'
    | 'installing'
    | 'error'
  current: string
  latest: AvailableUpdate | null
  // Download progress from 0 to 1 while downloading.
  progress: number | null
  error: string | null
  checkedAt: string | null
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>

const releasesSchema = z.array(
  z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    published_at: z.string().nullable(),
    html_url: z.string().url(),
    assets: z.array(
      z.object({
        name: z.string(),
        browser_download_url: z.string().url(),
        size: z.number(),
      }),
    ),
  }),
)

const versionPattern =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u

/** Semantic version order, including pre-release identifiers. */
export function compareVersions(left: string, right: string): number {
  const a = versionPattern.exec(left)
  const b = versionPattern.exec(right)
  if (!a || !b) throw new Error(`Cannot compare versions ${left} and ${right}.`)
  for (let index = 1; index <= 3; index++) {
    const difference = Number(a[index]) - Number(b[index])
    if (difference) return Math.sign(difference)
  }
  if (!a[4] || !b[4])
    return (
      a[4] ? -1
      : b[4] ? 1
      : 0
    )
  const x = a[4].split('.')
  const y = b[4].split('.')
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    if (x[index] === undefined) return -1
    if (y[index] === undefined) return 1
    const numeric = /^\d+$/u
    const xn = numeric.test(x[index])
    const yn = numeric.test(y[index])
    if (xn && yn) {
      const difference = Number(x[index]) - Number(y[index])
      if (difference) return Math.sign(difference)
    } else if (xn !== yn) return xn ? -1 : 1
    else if (x[index] !== y[index]) return x[index] < y[index] ? -1 : 1
  }
  return 0
}

/** Picks the newest published release, pre-releases included, above current. */
export function selectUpdate(
  releases: unknown,
  current: string,
): AvailableUpdate | null {
  let best: AvailableUpdate | null = null
  for (const release of releasesSchema.parse(releases)) {
    if (release.draft || !release.tag_name.startsWith(tagPrefix)) continue
    const version = release.tag_name.slice(tagPrefix.length)
    if (!versionPattern.test(version)) continue
    if (compareVersions(version, current) <= 0) continue
    if (best && compareVersions(version, best.version) <= 0) continue
    const name = `ModelBridge.Setup.${version}.exe`
    const installer = release.assets.find((asset) => asset.name === name)
    const checksum = release.assets.find(
      (asset) => asset.name === `${name}.sha256`,
    )
    if (!installer || !checksum) continue
    best = {
      version,
      tag: release.tag_name,
      prerelease: release.prerelease,
      publishedAt: release.published_at,
      pageUrl: release.html_url,
      installerUrl: installer.browser_download_url,
      checksumUrl: checksum.browser_download_url,
      size: installer.size,
    }
  }
  return best
}

export async function findUpdate(
  fetcher: Fetch,
  current: string,
): Promise<AvailableUpdate | null> {
  const response = await fetcher(releasesUrl, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': `ModelBridge/${current}`,
    },
    signal: AbortSignal.timeout(20_000),
  })
  if (response.status === 403 || response.status === 429)
    throw new Error(
      'GitHub is limiting update checks right now. Try again in an hour.',
    )
  if (!response.ok)
    throw new Error(`GitHub returned ${response.status} for the release list.`)
  return selectUpdate(await response.json(), current)
}

/** Downloads the installer and verifies it against the published SHA-256. */
export async function downloadUpdate(
  fetcher: Fetch,
  update: AvailableUpdate,
  directory: string,
  onProgress: (fraction: number) => void,
): Promise<string> {
  const checksumResponse = await fetcher(update.checksumUrl, {
    signal: AbortSignal.timeout(30_000),
  })
  if (!checksumResponse.ok)
    throw new Error(
      `The release checksum could not be downloaded (${checksumResponse.status}).`,
    )
  const expected = /^([a-f0-9]{64})\b/iu
    .exec((await checksumResponse.text()).trim())?.[1]
    ?.toLowerCase()
  if (!expected) throw new Error('The release checksum file is not valid.')
  if (update.size <= 0 || update.size > maxInstallerBytes)
    throw new Error('The release installer has an unexpected size.')

  fs.rmSync(directory, { recursive: true, force: true })
  fs.mkdirSync(directory, { recursive: true })
  const target = path.join(directory, `ModelBridge.Setup.${update.version}.exe`)
  const partial = `${target}.partial`
  const response = await fetcher(update.installerUrl, {
    signal: AbortSignal.timeout(30 * 60_000),
  })
  if (!response.ok || !response.body)
    throw new Error(
      `The installer could not be downloaded (${response.status}).`,
    )
  const hash = createHash('sha256')
  const file = await fs.promises.open(partial, 'w')
  let received = 0
  try {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > update.size) {
        await reader.cancel()
        throw new Error('The installer download is larger than published.')
      }
      hash.update(value)
      await file.write(value)
      onProgress(received / update.size)
    }
  } catch (error) {
    await file.close()
    fs.rmSync(partial, { force: true })
    throw error
  }
  await file.close()
  if (hash.digest('hex') !== expected || received !== update.size) {
    fs.rmSync(partial, { force: true })
    throw new Error(
      'The downloaded installer does not match its published checksum, so it was deleted.',
    )
  }
  fs.renameSync(partial, target)
  return target
}
