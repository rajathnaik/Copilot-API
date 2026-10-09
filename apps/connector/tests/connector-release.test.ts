import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { isMap, isSeq, parseDocument } from 'yaml'
import builder from '../connector-builder.json'
import manifest from '../package.json'
import {
  connectorReleaseMetadata,
  writeConnectorReleaseOutputs,
} from '../scripts/connector-release'

const tagged = {
  eventName: 'push',
  refType: 'tag',
  refName: `connector-v${manifest.version}`,
}

describe('approved independent Connector releases', () => {
  test('resolves only a matching product tag or approved manual version', () => {
    const expected = {
      version: manifest.version,
      tag: tagged.refName,
    }
    expect(connectorReleaseMetadata(builder, manifest, tagged)).toEqual(
      expected,
    )
    expect(
      connectorReleaseMetadata(builder, manifest, {
        eventName: 'workflow_dispatch',
        requestedVersion: manifest.version,
      }),
    ).toEqual(expected)
  })

  test('rejects branch pushes, Gateway tags, unsupported events and version mismatches', () => {
    for (const source of [
      { ...tagged, refType: 'branch' },
      { ...tagged, refName: `v${manifest.version}` },
      { ...tagged, refName: 'connector-v0.0.0' },
      { eventName: 'pull_request' },
      { eventName: 'workflow_dispatch', requestedVersion: '0.0.0' },
    ])
      expect(() =>
        connectorReleaseMetadata(builder, manifest, source),
      ).toThrow()
    expect(() => connectorReleaseMetadata({}, manifest, tagged)).toThrow(
      'Connector',
    )
    expect(() => connectorReleaseMetadata(builder, {}, tagged)).toThrow(
      'Connector',
    )
    expect(() =>
      connectorReleaseMetadata(
        { ...builder, extraMetadata: { version: manifest.version } },
        manifest,
        tagged,
      ),
    ).toThrow('build overrides')
    for (const version of [null, '', '2.7', '02.7.1', '2.7.1-beta.1']) {
      expect(() =>
        connectorReleaseMetadata(builder, { ...manifest, version }, tagged),
      ).toThrow('semantic version')
    }
  })

  test('writes validated GitHub outputs from the actual committed product metadata', () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'connector-release-'),
    )
    try {
      const output = path.join(directory, 'output')
      const script = path.resolve('scripts', 'connector-release.ts')
      const env = {
        ...process.env,
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF_TYPE: 'tag',
        GITHUB_REF_NAME: tagged.refName,
        GITHUB_OUTPUT: output,
      }
      writeConnectorReleaseOutputs(env)
      expect(fs.readFileSync(output, 'utf8')).toBe(
        `version=${manifest.version}\ntag=${tagged.refName}\n`,
      )
      expect(() =>
        writeConnectorReleaseOutputs({ ...env, GITHUB_OUTPUT: '' }),
      ).toThrow('output path')
      execFileSync('node', [script], { env, stdio: 'pipe' })
      expect(() =>
        execFileSync('node', [script], {
          env: { ...env, GITHUB_OUTPUT: '' },
          stdio: 'pipe',
        }),
      ).toThrow()
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  test('keeps Connector publishing separate from Gateway release automation', () => {
    const root = path.resolve('..', '..', '.github', 'workflows')
    const connector = fs.readFileSync(
      path.join(root, 'release-connector.yml'),
      'utf8',
    )
    const document = parseDocument(connector)
    expect(document.errors).toHaveLength(0)
    expect(document.getIn(['on', 'push', 'tags', 0])).toBe('connector-v*')
    expect(document.getIn(['on', 'push', 'branches'])).toBeUndefined()
    expect(
      document.getIn([
        'on',
        'workflow_dispatch',
        'inputs',
        'version',
        'required',
      ]),
    ).toBe(true)
    expect(connector).toContain('--latest=false')
    expect(connector).toContain('SHA256SUMS.txt')
    const platforms = document.getIn([
      'jobs',
      'build',
      'strategy',
      'matrix',
      'include',
    ])
    if (!isSeq(platforms))
      throw new Error('Connector release platform matrix is missing.')
    expect(platforms.toJSON()).toContainEqual({
      os: 'ubuntu-latest',
      platform: 'linux',
      arch: 'x64',
      artifact: 'Copilot-API-Connector-',
      suffix: '-linux-x86_64.AppImage',
    })
    expect(connector).toContain('node ../../scripts/ensure-electron.mjs')
    expect(connector).toContain('node -p "require(\'electron\')"')
    expect(connector).toContain('git rev-parse "refs/tags/$TAG^{commit}"')
    const gateway = fs.readFileSync(
      path.join(root, 'release-desktop.yml'),
      'utf8',
    )
    expect(gateway).not.toContain('package:connector')
    expect(gateway).not.toContain('release-connector')
    const gatewayDocument = parseDocument(gateway)
    expect(gatewayDocument.errors).toHaveLength(0)
    expect(gatewayDocument.getIn(['on', 'push', 'tags', 0])).toBe('v*')
    expect(gatewayDocument.getIn(['on', 'push', 'branches'])).toBeUndefined()
    expect(gatewayDocument.getIn(['jobs', 'build', 'needs'])).toBe('validate')
    const publishNeeds = gatewayDocument.getIn(['jobs', 'publish', 'needs'])
    if (!isSeq(publishNeeds))
      throw new Error('Gateway publish prerequisites are missing.')
    expect(publishNeeds.toJSON()).toEqual(['validate', 'build'])
    expect(gateway).toContain('gh release create "$TAG" --verify-tag')
    expect(gateway).toContain('sha256sum *.exe *.dmg *.AppImage')
  })

  test('accepts an absent or matching tag but refuses a tag from another source commit', () => {
    const document = parseDocument(
      fs.readFileSync(
        path.resolve(
          '..',
          '..',
          '.github',
          'workflows',
          'release-connector.yml',
        ),
        'utf8',
      ),
    )
    const steps = document.getIn(['jobs', 'validate', 'steps'])
    if (!isSeq(steps)) throw new Error('Release validation steps are missing.')
    const step = steps.items.find(
      (item) =>
        isMap(item)
        && item.get('name')
          === 'Verify existing release tag points to this source',
    )
    if (!isMap(step)) throw new Error('Release source validation is missing.')
    const script = step.get('run')
    if (typeof script !== 'string')
      throw new Error('Release source validation must be a shell command.')
    const bash =
      process.platform === 'win32' ?
        path.resolve(
          execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(),
          '..',
          '..',
          '..',
          'bin',
          'bash.exe',
        )
      : 'bash'
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-tag-'))
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Connector Release Test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Connector Release Test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
      TAG: tagged.refName,
    }
    const git = (args: string[], input?: string) =>
      execFileSync('git', args, {
        cwd: directory,
        env,
        input,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
    try {
      git(['init', '--quiet'])
      const tree = git(['mktree'], '')
      const source = git([
        'commit-tree',
        tree,
        '-m',
        'Synthetic release source',
      ])
      const other = git(['commit-tree', tree, '-m', 'Different source'])
      const run = (sha: string) =>
        execFileSync(bash, ['-c', script], {
          cwd: directory,
          env: { ...env, GITHUB_SHA: sha },
          stdio: 'pipe',
        })
      expect(() => run(source)).not.toThrow()
      git(['update-ref', `refs/tags/${tagged.refName}`, source])
      expect(() => run(source)).not.toThrow()
      expect(() => run(other)).toThrow()
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
