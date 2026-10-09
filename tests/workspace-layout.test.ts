import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import workspace from '../package.json'
import gateway from '../apps/gateway/package.json'
import desktop from '../apps/gateway/desktop/package.json'
import connector from '../apps/connector/package.json'
import connectorBuilder from '../apps/connector/connector-builder.json'
import shared from '../packages/shared/package.json'

const root = fileURLToPath(new URL('..', import.meta.url))

describe('independent product workspace', () => {
  test('keeps versions and installed identities in product-owned manifests', () => {
    expect(workspace.private).toBe(true)
    expect(workspace.workspaces).toEqual([
      'apps/gateway',
      'apps/gateway/desktop',
      'apps/connector',
      'packages/shared',
    ])
    expect(gateway.name).toBe('@jeffreycao/copilot-api')
    expect(desktop.build.appId).toBe('com.copilot-api.desktop')
    expect(desktop.version).toBe(gateway.version)
    expect(connector.name).toBe('copilot-api-connector')
    expect(connectorBuilder.appId).toBe('com.copilot-api.connector')
    expect(connectorBuilder.productName).toBe('Copilot API Connector')
    expect(connector.main).toBe('out-connector/main/index.js')
    expect(desktop.devDependencies.electron).toBe(
      connector.devDependencies.electron,
    )
    expect(connector.devDependencies.electron).toMatch(/^\d+\.\d+\.\d+$/u)
    expect(shared.private).toBe(true)
    expect(gateway.dependencies).not.toHaveProperty('@copilot-api/shared')
    expect(
      fs
        .readFileSync(path.join(root, 'apps/gateway/LICENSE'), 'utf8')
        .replaceAll('\r\n', '\n'),
    ).toBe(
      fs
        .readFileSync(path.join(root, 'LICENSE'), 'utf8')
        .replaceAll('\r\n', '\n'),
    )
  })

  test('runs suites from their owning directories without cross-workspace discovery', () => {
    for (const manifest of [gateway, desktop, connector, shared])
      expect(manifest.scripts.test).toBe('bun test ./tests')
    expect(workspace.scripts.test).toStartWith('bun test ./tests &&')
    for (const folder of [
      'apps/gateway',
      'apps/gateway/desktop',
      'apps/connector',
      'packages/shared',
    ])
      expect(workspace.scripts.test).toContain(`bun run --cwd ${folder} test`)
  })

  test('keeps Connector source and native tests independent of Gateway code', () => {
    const directory = path.join(root, 'apps', 'connector')
    const visit = (folder: string): void => {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (
          entry.isDirectory()
          && ['src', 'electron', 'scripts', 'tests', 'connector'].includes(
            entry.name,
          )
        )
          visit(path.join(folder, entry.name))
        else if (entry.isFile() && /\.tsx?$/u.test(entry.name))
          expect(
            fs.readFileSync(path.join(folder, entry.name), 'utf8'),
          ).not.toMatch(
            /(?:from|import\s*\()\s*['"][^'"]*(?:gateway\/|desktop\/|~\/)/u,
          )
      }
    }
    visit(directory)
    expect(connector.dependencies).not.toHaveProperty('electron-updater')
    expect(desktop.scripts).not.toHaveProperty('package:connector')
  })

  test('uses one frozen workspace install and correct release/package paths', () => {
    const workflows = path.join(root, '.github', 'workflows')
    for (const file of [
      'ci.yml',
      'release.yml',
      'release-desktop.yml',
      'release-connector.yml',
    ]) {
      const content = fs.readFileSync(path.join(workflows, file), 'utf8')
      expect(content).not.toMatch(/working-directory: desktop\b/u)
      expect(content).not.toMatch(/path: desktop\//u)
    }
    expect(desktop.build.extraResources).toContainEqual({
      from: '../dist',
      to: 'server',
      filter: ['**/*.js'],
    })
    expect(connectorBuilder.extraResources).toContainEqual({
      from: '../../LICENSE',
      to: 'licenses/copilot-api.txt',
    })
    for (const resource of connectorBuilder.extraResources)
      expect(
        fs.existsSync(path.resolve(root, 'apps', 'connector', resource.from)),
        resource.from,
      ).toBe(true)
  })
})
