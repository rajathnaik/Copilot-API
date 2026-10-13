import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { CredentialCodec } from '@modelbridge/runtime/credentials'

const prefix = 'modelbridge-dpapi-v1:'

export function windowsCredentialCodec(
  directory: string,
  legacy: CredentialCodec,
): CredentialCodec {
  fs.mkdirSync(directory, { recursive: true })
  const entropy = createHash('sha256')
    .update(fs.realpathSync.native(directory).toLowerCase())
    .digest('hex')
  const shell = path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  const cache = new Map<string, string>()
  const remember = (encrypted: string, plain: string) => {
    if (cache.size >= 32) {
      const first = cache.keys().next().value
      if (first !== undefined) cache.delete(first)
    }
    cache.set(encrypted, plain)
    return plain
  }
  function transform(value: string, operation: 'Protect' | 'Unprotect') {
    const script = [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.Security',
      '$data = [Convert]::FromBase64String([Console]::In.ReadToEnd())',
      `$entropy = [Text.Encoding]::UTF8.GetBytes("${entropy}")`,
      `$result = [Security.Cryptography.ProtectedData]::${operation}($data, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)`,
      '[Console]::Write([Convert]::ToBase64String($result))',
    ].join('; ')
    const result = spawnSync(
      shell,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        input: value,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    )
    if (
      result.error
      || result.status !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(result.stdout.trim())
    )
      throw new Error(
        `Windows protected credential ${operation.toLowerCase()} failed. Preserve the profile and check its OS user and permissions.`,
        {
          cause:
            result.error
            ?? new Error(`PowerShell exited with status ${result.status}.`),
        },
      )
    return result.stdout.trim()
  }
  return {
    encrypt(value) {
      const encrypted =
        prefix + transform(Buffer.from(value).toString('base64'), 'Protect')
      remember(encrypted, value)
      return encrypted
    },
    decrypt(value) {
      const existing = cache.get(value)
      if (existing !== undefined) return existing
      // Independent processes must not depend on Chromium's profile-key cache.
      const plain =
        value.startsWith(prefix) ?
          Buffer.from(
            transform(value.slice(prefix.length), 'Unprotect'),
            'base64',
          ).toString('utf8')
        : legacy.decrypt(value)
      return remember(value, plain)
    },
  }
}
