import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = fileURLToPath(new URL('..', import.meta.url))
const launcher = fs.readFileSync(
  path.join(workspace, 'launch-desktop.ps1'),
  'utf8',
)

test.skipIf(process.platform !== 'win32')(
  'Windows PowerShell launcher resolves the actual Electron executable',
  () => {
    const resolver = launcher.match(/^\$electron = & \$bun .+$/mu)?.[0]
    if (!resolver) throw new Error('Launcher Electron resolver was not found.')
    const bun = process.execPath.replaceAll("'", "''")
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$bun = '${bun}'; ${resolver}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; $electron`,
      ],
      { cwd: workspace, encoding: 'utf8', timeout: 30000 },
    ).trim()
    const workspaceRequire = createRequire(path.join(workspace, 'package.json'))
    const expected = path.join(
      path.dirname(workspaceRequire.resolve('electron/package.json')),
      'dist',
      'electron.exe',
    )
    expect(path.normalize(output).toLowerCase()).toBe(
      path.normalize(expected).toLowerCase(),
    )
    expect(fs.existsSync(output)).toBe(true)
  },
  35000,
)
