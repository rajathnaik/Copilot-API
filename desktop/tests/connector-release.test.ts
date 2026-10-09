import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseDocument } from 'yaml'
import builder from '../connector-builder.json'
import {
  connectorReleaseMetadata,
  writeConnectorReleaseOutputs,
} from '../scripts/connector-release'

const tagged = {
  eventName: 'push',
  refType: 'tag',
  refName: `connector-v${builder.extraMetadata.version}`,
}

describe('approved independent Connector releases', () => {
  test('resolves only a matching product tag or approved manual version', () => {
    const expected = {
      version: builder.extraMetadata.version,
      tag: tagged.refName,
    }
    expect(connectorReleaseMetadata(builder, tagged)).toEqual(expected)
    expect(
      connectorReleaseMetadata(builder, {
        eventName: 'workflow_dispatch',
        requestedVersion: builder.extraMetadata.version,
      }),
    ).toEqual(expected)
  })

  test('rejects branch pushes, Gateway tags, unsupported events and version mismatches', () => {
    for (const source of [
      { ...tagged, refType: 'branch' },
      { ...tagged, refName: `v${builder.extraMetadata.version}` },
      { ...tagged, refName: 'connector-v0.0.0' },
      { eventName: 'pull_request' },
      { eventName: 'workflow_dispatch', requestedVersion: '0.0.0' },
    ])
      expect(() => connectorReleaseMetadata(builder, source)).toThrow()
    expect(() => connectorReleaseMetadata({}, tagged)).toThrow('Connector')
    for (const version of [null, '', '2.7', '02.7.1', '2.7.1-beta.1']) {
      expect(() =>
        connectorReleaseMetadata(
          {
            ...builder,
            extraMetadata: { ...builder.extraMetadata, version },
          },
          tagged,
        ),
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
        `version=${builder.extraMetadata.version}\ntag=${tagged.refName}\n`,
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
    const root = path.resolve('..', '.github', 'workflows')
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
    const gateway = fs.readFileSync(
      path.join(root, 'release-desktop.yml'),
      'utf8',
    )
    expect(gateway).not.toContain('package:connector')
    expect(gateway).not.toContain('release-connector')
    expect(parseDocument(gateway).errors).toHaveLength(0)
  })
})
