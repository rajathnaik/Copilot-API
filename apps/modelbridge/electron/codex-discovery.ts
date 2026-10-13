import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'

const execute = promisify(execFile)
export interface CodexInstallation {
  executable: string
  version: string
  kind: 'desktop' | 'cli'
}

export function codexConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
) {
  return path.join(
    env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex'),
    'config.toml',
  )
}
export function codexCandidates(env: NodeJS.ProcessEnv = process.env) {
  const candidates: string[] = []
  for (const entry of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const root = entry.replace(/^"|"$/gu, '')
    candidates.push(
      path.join(root, process.platform === 'win32' ? 'codex.exe' : 'codex'),
    )
    for (const target of ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc'])
      for (const name of ['codex', 'codex-win32-x64', 'codex-win32-arm64'])
        candidates.push(
          path.join(
            root,
            'node_modules',
            '@openai',
            name,
            'vendor',
            target,
            'codex',
            'codex.exe',
          ),
        )
  }
  if (process.platform === 'win32') {
    for (const root of [
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'),
      env.ProgramFiles,
    ]) {
      if (!root) continue
      for (const name of ['Codex', 'ChatGPT'])
        candidates.push(
          path.join(root, name, 'resources', 'codex.exe'),
          path.join(root, name, 'app', 'resources', 'codex.exe'),
        )
    }
  }
  return [...new Set(candidates)]
}
export function parseCodexVersion(value: string) {
  const match = /^codex(?:-cli)?\s+(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/u.exec(
    value.trim(),
  )
  if (!match)
    throw new Error('The executable did not report a valid Codex CLI version.')
  if (Number(match[1]) === 0 && Number(match[2]) < 160)
    throw new Error(
      'Update Codex to version 0.160.0 or newer before using protected provider authentication.',
    )
  return value.trim().replace(/^codex(?:-cli)?\s+/u, '')
}
export async function inspectCodex(
  executable: string,
): Promise<CodexInstallation> {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const { stdout } = await execute(executable, ['--version'], {
    env,
    timeout: 10_000,
    windowsHide: true,
    maxBuffer: 64 * 1024,
  })
  return {
    executable,
    version: parseCodexVersion(stdout),
    kind:
      executable.toLowerCase().includes(`${path.sep}resources${path.sep}`) ?
        'desktop'
      : 'cli',
  }
}
export async function discoverCodex(): Promise<{
  installations: CodexInstallation[]
  warnings: string[]
}> {
  const candidates = codexCandidates()
  const warnings: string[] = []
  if (process.platform === 'win32') {
    try {
      const shell = path.join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      )
      const { stdout } = await execute(
        shell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'ConvertTo-Json -InputObject @(Get-AppxPackage -Name OpenAI.Codex | Select-Object -ExpandProperty InstallLocation) -Compress',
        ],
        { timeout: 15_000, windowsHide: true, maxBuffer: 64 * 1024 },
      )
      const roots =
        stdout.trim() ? z.array(z.string()).parse(JSON.parse(stdout)) : []
      for (const root of roots)
        candidates.push(path.join(root, 'app', 'resources', 'codex.exe'))
    } catch (error) {
      warnings.push(
        `Windows Codex package discovery failed: ${error instanceof Error ? error.message : 'Unknown failure'}`,
      )
    }
  }
  const installations: CodexInstallation[] = []
  for (const candidate of [...new Set(candidates)]) {
    if (!fs.existsSync(candidate)) continue
    try {
      installations.push(await inspectCodex(candidate))
    } catch (error) {
      warnings.push(
        `Could not use ${candidate}: ${error instanceof Error ? error.message : 'Unknown failure'}`,
      )
    }
  }
  return { installations, warnings }
}
