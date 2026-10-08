import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CodexInstallation } from '../../src/types/connector'

export const MIN_CODEX_VERSION = '0.160.0'

export interface CommandOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeout: number
}

export type CommandRunner = (
  executable: string,
  args: string[],
  options: CommandOptions,
) => Promise<{ stdout: string; stderr: string }>

export const runCommand: CommandRunner = (executable, args, options) =>
  new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...options.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = execFile(
      executable,
      args,
      {
        ...options,
        env,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            error instanceof Error ? error : new Error('Codex command failed.'),
          )
        else resolve({ stdout, stderr })
      },
    )
    // Codex reads piped stdin even when a prompt argument is supplied.
    child.stdin?.end()
  })

export async function verifyCredentialHelper(
  command: string,
  args: string[],
  expectedKey: string,
  runner: CommandRunner = runCommand,
): Promise<void> {
  const { stdout } = await runner(command, args, { timeout: 30_000 })
  if (stdout.trim() !== expectedKey) {
    throw new Error(
      'The installed credential helper did not return the expected gateway key.',
    )
  }
}

export function parseCodexVersion(output: string): string {
  const match = output
    .trim()
    .match(/^codex(?:-cli)?\s+(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/u)
  if (!match)
    throw new Error(
      'The selected executable did not report a valid Codex CLI version.',
    )
  if (Number(match[1]) === 0 && Number(match[2]) < 160) {
    throw new Error(
      `Update Codex to ${MIN_CODEX_VERSION} or newer before connecting.`,
    )
  }
  return `${match[1]}.${match[2]}.${match[3]}`
}

export function codexConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string {
  return path.join(
    env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex'),
    'config.toml',
  )
}

export function codexCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string[] {
  const windows = platform === 'win32'
  const paths = windows ? path.win32 : path.posix
  const entries = (env.PATH ?? '').split(windows ? ';' : ':').filter(Boolean)
  const candidates = entries.map((entry) =>
    paths.join(entry.replace(/^"|"$/g, ''), windows ? 'codex.exe' : 'codex'),
  )
  if (windows) {
    const targets = ['x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc']
    const roots = [
      ...entries,
      ...(env.APPDATA ? [paths.join(env.APPDATA, 'npm')] : []),
    ]
    for (const root of roots) {
      const modules =
        paths.basename(root) === '.bin' ?
          paths.dirname(root)
        : paths.join(root, 'node_modules')
      for (const pkg of ['codex', 'codex-win32-x64', 'codex-win32-arm64']) {
        for (const target of targets) {
          for (const directory of ['bin', 'codex']) {
            candidates.push(
              paths.join(
                modules,
                '@openai',
                pkg,
                'vendor',
                target,
                directory,
                'codex.exe',
              ),
            )
          }
        }
      }
    }
    if (env.LOCALAPPDATA) {
      candidates.push(
        paths.join(
          env.LOCALAPPDATA,
          'Programs',
          'Codex',
          'resources',
          'codex.exe',
        ),
      )
    }
  } else {
    candidates.push(
      '/usr/local/bin/codex',
      '/opt/homebrew/bin/codex',
      paths.join(home, '.local', 'bin', 'codex'),
    )
    if (platform === 'darwin') {
      candidates.push(
        '/Applications/Codex.app/Contents/Resources/codex',
        paths.join(
          home,
          'Applications',
          'Codex.app',
          'Contents',
          'Resources',
          'codex',
        ),
      )
    }
  }
  return [...new Set(candidates)]
}

export async function detectCodex(
  selected: string | null,
  runner: CommandRunner = runCommand,
  configPath = codexConfigPath(),
): Promise<CodexInstallation | null> {
  const candidates = selected ? [selected] : codexCandidates()
  for (const executable of candidates) {
    if (!fs.existsSync(executable)) continue
    const version = parseCodexVersion(
      (await runner(executable, ['--version'], { timeout: 15_000 })).stdout,
    )
    return { executable, version, configPath }
  }
  if (selected)
    throw new Error(
      'The selected Codex executable no longer exists. Select it again.',
    )
  return null
}

export async function verifyNativeCodex(
  installation: CodexInstallation,
  configuration: string,
  runner: CommandRunner = runCommand,
): Promise<void> {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'copilot-connector-check-'),
  )
  const configPath = path.join(directory, 'config.toml')
  const outputPath = path.join(directory, 'result.txt')
  fs.writeFileSync(configPath, configuration, { mode: 0o600 })
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: directory }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    await runner(
      installation.executable,
      [
        'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '-c',
        'web_search="disabled"',
        '-c',
        'analytics.enabled=false',
        '--output-last-message',
        outputPath,
        'Reply with exactly COPILOT_CONNECTOR_OK. Do not use tools or run commands.',
      ],
      { cwd: directory, env, timeout: 120_000 },
    )
    if (
      !fs.existsSync(outputPath)
      || fs.readFileSync(outputPath, 'utf8').trim() !== 'COPILOT_CONNECTOR_OK'
    ) {
      throw new Error(
        'Codex did not return the expected connection-test reply.',
      )
    }
  } finally {
    // Only this freshly created verification directory is removed.
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
