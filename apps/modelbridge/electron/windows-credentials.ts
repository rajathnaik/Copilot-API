import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { CredentialCodec } from '@modelbridge/runtime/credentials'

const prefix = 'modelbridge-dpapi-v1:'
const base64 = /^[A-Za-z0-9+/]+={0,2}$/u
const outputLimit = 16 * 1024 * 1024

type Operation = 'Protect' | 'Unprotect'
export type PowerShellRunner = (
  script: string,
  input: string,
  timeoutMs: number,
) => Promise<{ status: number | null; stdout: string }>

export function windowsPowerShell(): string {
  return path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
}

/** Runs PowerShell without blocking the Electron main thread. */
export const runPowerShell: PowerShellRunner = (script, input, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      windowsPowerShell(),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true },
    )
    let stdout = ''
    let settled = false
    const finish = (error: Error | null, status: number | null = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve({ status, stdout })
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(
        new Error(
          `PowerShell did not respond within ${Math.round(timeoutMs / 1000)} seconds. Security software may be blocking or delaying it.`,
        ),
      )
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      if (stdout.length > outputLimit) {
        child.kill()
        finish(new Error('PowerShell returned an oversized response.'))
      }
    })
    child.stderr.resume()
    child.stdin.on('error', () => undefined)
    child.on('error', (error) => finish(error))
    child.on('close', (status) => finish(null, status))
    child.stdin.end(input)
  })

interface Request {
  operation: Operation
  data: string
  resolve(value: string): void
  reject(error: Error): void
}

function failure(operation: Operation, cause: unknown): Error {
  return new Error(
    `Windows protected credential ${operation.toLowerCase()} failed. Preserve the profile and check its OS user and permissions.`,
    { cause },
  )
}

export function windowsCredentialCodec(
  directory: string,
  legacy: CredentialCodec,
  options: { run?: PowerShellRunner; timeoutMs?: number } = {},
): CredentialCodec {
  const run = options.run ?? runPowerShell
  const timeoutMs = options.timeoutMs ?? 30_000
  fs.mkdirSync(directory, { recursive: true })
  const entropy = createHash('sha256')
    .update(fs.realpathSync.native(directory).toLowerCase())
    .digest('hex')
  // One process handles every queued request, so startup costs a single launch.
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Security',
    `$entropy = [Text.Encoding]::UTF8.GetBytes("${entropy}")`,
    '$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser',
    '$output = New-Object Text.StringBuilder',
    'foreach ($line in [Console]::In.ReadToEnd().Split([char]10)) { $item = $line.Trim(); if ($item.Length -eq 0) { continue }; try { $data = [Convert]::FromBase64String($item.Substring(2)); if ($item.StartsWith("P:")) { $result = [Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope) } else { $result = [Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, $scope) }; [void]$output.Append("+" + [Convert]::ToBase64String($result) + [char]10) } catch { [void]$output.Append("-" + [char]10) } }',
    '[Console]::Write($output.ToString())',
  ].join('; ')
  let pending: Request[] = []
  let scheduled = false
  let running = false
  const schedule = () => {
    if (scheduled || running || !pending.length) return
    scheduled = true
    setImmediate(() => void drain())
  }
  async function drain() {
    scheduled = false
    running = true
    const batch = pending
    pending = []
    try {
      const input = batch
        .map(
          (item) => `${item.operation === 'Protect' ? 'P' : 'U'}:${item.data}`,
        )
        .join('\n')
      const result = await run(script, `${input}\n`, timeoutMs)
      const lines = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      if (result.status !== 0 || lines.length !== batch.length)
        throw new Error(`PowerShell exited with status ${result.status}.`)
      batch.forEach((item, index) => {
        const value = lines[index].slice(1)
        if (lines[index].startsWith('+') && base64.test(value))
          item.resolve(value)
        else
          item.reject(
            failure(item.operation, new Error('The record was rejected.')),
          )
      })
    } catch (error) {
      for (const item of batch) item.reject(failure(item.operation, error))
    } finally {
      running = false
      schedule()
    }
  }
  const transform = (data: string, operation: Operation) =>
    new Promise<string>((resolve, reject) => {
      if (!base64.test(data)) {
        reject(failure(operation, new Error('The record is not valid data.')))
        return
      }
      pending.push({ operation, data, resolve, reject })
      schedule()
    })
  return {
    async encrypt(value) {
      return (
        prefix
        + (await transform(Buffer.from(value).toString('base64'), 'Protect'))
      )
    },
    async decrypt(value) {
      // Independent processes must not depend on Chromium's profile-key cache.
      if (!value.startsWith(prefix)) return legacy.decrypt(value)
      return Buffer.from(
        await transform(value.slice(prefix.length), 'Unprotect'),
        'base64',
      ).toString('utf8')
    },
    isCurrent: (encrypted) => encrypted.startsWith(prefix),
  }
}
