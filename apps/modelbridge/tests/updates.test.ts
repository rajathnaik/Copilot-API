import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  compareVersions,
  downloadUpdate,
  findUpdate,
  selectUpdate,
  type AvailableUpdate,
} from '../electron/updates'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true })
})

function release(
  version: string,
  options: { draft?: boolean; prerelease?: boolean; assets?: string[] } = {},
) {
  const name = `ModelBridge.Setup.${version}.exe`
  return {
    tag_name: `modelbridge-v${version}`,
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? true,
    published_at: '2026-11-03T00:00:00Z',
    html_url: `https://github.com/rajathnaik/Copilot-API/releases/tag/modelbridge-v${version}`,
    assets: (options.assets ?? [name, `${name}.sha256`]).map((asset) => ({
      name: asset,
      browser_download_url: `https://example.test/${asset}`,
      size: 4,
    })),
  }
}

test('orders versions with pre-releases below their release', () => {
  expect(compareVersions('0.1.3', '0.1.2')).toBe(1)
  expect(compareVersions('0.1.10', '0.1.9')).toBe(1)
  expect(compareVersions('0.2.0-dev.7', '0.2.0')).toBe(-1)
  expect(compareVersions('0.2.0-dev.10', '0.2.0-dev.9')).toBe(1)
  expect(compareVersions('0.2.0-dev.1', '0.2.0-dev')).toBe(1)
  expect(compareVersions('1.0.0-alpha', '1.0.0-1')).toBe(1)
  expect(compareVersions('0.1.2', '0.1.2')).toBe(0)
})

test('selects the newest installable release, skipping drafts and incomplete releases', () => {
  const releases = [
    release('0.1.9', { draft: true }),
    release('0.1.8', { assets: ['ModelBridge.Setup.0.1.8.exe'] }),
    { ...release('0.1.7'), tag_name: 'gateway-v0.1.7' },
    release('0.1.4-dev.1'),
    release('0.1.4', { prerelease: false }),
    release('0.1.2'),
  ]
  expect(selectUpdate(releases, '0.1.3')).toMatchObject({
    version: '0.1.4',
    prerelease: false,
    installerUrl: 'https://example.test/ModelBridge.Setup.0.1.4.exe',
  })
  expect(selectUpdate(releases, '0.1.4')).toBeNull()
})

test('explains GitHub rate limits during the check', async () => {
  const fetcher = async () => new Response('', { status: 403 })
  await expect(findUpdate(fetcher, '0.1.3')).rejects.toThrow('limiting')
})

function update(content: Buffer): AvailableUpdate {
  return {
    version: '0.1.4',
    tag: 'modelbridge-v0.1.4',
    prerelease: true,
    publishedAt: null,
    pageUrl: 'https://github.com/rajathnaik/Copilot-API/releases',
    installerUrl: 'https://example.test/installer',
    checksumUrl: 'https://example.test/checksum',
    size: content.length,
  }
}

test('downloads and verifies the installer against the published checksum', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'modelbridge-update-'),
  )
  directories.push(directory)
  const content = Buffer.from('installer bytes')
  const digest = createHash('sha256').update(content).digest('hex')
  const served = (checksum: string) => async (url: string) =>
    url.endsWith('checksum') ?
      new Response(`${checksum}  ModelBridge.Setup.0.1.4.exe\n`)
    : new Response(content)
  const progress: number[] = []
  const file = await downloadUpdate(
    served(digest.toUpperCase()),
    update(content),
    directory,
    (value) => progress.push(value),
  )
  expect(fs.readFileSync(file)).toEqual(content)
  expect(progress.at(-1)).toBe(1)

  await expect(
    downloadUpdate(
      served('0'.repeat(64)),
      update(content),
      directory,
      () => {},
    ),
  ).rejects.toThrow('does not match')
  expect(fs.readdirSync(directory)).toEqual([])
})
