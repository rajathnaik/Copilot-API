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
    expect(gateway.name).toBe('copilot-api-gateway')
    expect(gateway.private).toBe(true)
    expect(gateway.scripts).not.toHaveProperty('release')
    expect(desktop.build.publish.owner).toBe('rajathnaik')
    expect(desktop.build.publish.repo).toBe('Copilot-API')
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

  test('keeps fork-owned installer workflows without upstream publishing', () => {
    const workflows = path.join(root, '.github', 'workflows')
    expect(fs.readdirSync(workflows).sort()).toEqual([
      'ci.yml',
      'release-connector.yml',
      'release-desktop.yml',
    ])
    const release = fs.readFileSync(
      path.join(workflows, 'release-desktop.yml'),
      'utf8',
    )
    expect(release).toContain('node apps/gateway/scripts/gateway-release.ts')
    expect(release).toContain('gh release create "$TAG" --verify-tag --latest')
    expect(release).toContain('SHA256SUMS.txt')
    expect(release).not.toMatch(/npm publish|changelogithub|registry\.npmjs/u)
    const compose = fs.readFileSync(
      path.join(root, 'docker-compose.yaml'),
      'utf8',
    )
    expect(compose).not.toContain('ghcr.io')
    expect(
      compose.match(/dockerfile: apps\/gateway\/Dockerfile/gu),
    ).toHaveLength(2)
    expect(compose.match(/pull_policy: never/gu)).toHaveLength(2)
    for (const entry of Object.values(shared.exports))
      expect(
        fs.existsSync(path.resolve(root, 'packages', 'shared', entry)),
      ).toBe(true)
    expect(shared.exports).not.toHaveProperty('./locales/zh')
  })

  test('uses the local fork MCP bridge instead of installing an upstream package', () => {
    const config = JSON.parse(
      fs.readFileSync(
        path.join(root, 'plugin', 'claude', 'tool-search', '.mcp.json'),
        'utf8',
      ),
    ) as { mcpServers: { tool_search: { command: string; args: string[] } } }
    expect(config.mcpServers.tool_search.command).toBe('bun')
    expect(config.mcpServers.tool_search.args).toEqual([
      '${COPILOT_API_GATEWAY_ENTRY}',
      'mcp',
    ])
  })

  test('keeps English documentation links and screenshots resolvable', () => {
    const guides = path.join(root, 'docs', 'guides', 'en')
    const documents = [
      path.join(root, 'README.md'),
      path.join(root, 'NOTICE.md'),
      path.join(root, 'apps', 'gateway', 'README.md'),
      path.join(root, 'apps', 'connector', 'README.md'),
      ...fs
        .readdirSync(guides)
        .filter((name) => name.endsWith('.md'))
        .map((name) => path.join(guides, name)),
    ]
    for (const file of documents) {
      const content = fs.readFileSync(file, 'utf8')
      expect(content, file).not.toMatch(/zh-CN\/|README\.zh-CN/u)
      const targets = [
        ...Array.from(
          content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu),
          (match) => match[1],
        ),
        ...Array.from(
          content.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gu),
          (match) => match[1],
        ),
      ]
      for (const target of targets) {
        if (/^(?:https?:|mailto:|#)/u.test(target)) continue
        const relative = decodeURIComponent(target.split('#')[0])
        expect(
          fs.existsSync(path.resolve(path.dirname(file), relative)),
          `${file}: ${target}`,
        ).toBe(true)
      }
    }
  })
})
