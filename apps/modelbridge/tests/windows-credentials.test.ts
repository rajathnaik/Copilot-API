import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  runPowerShell,
  windowsCredentialCodec,
  type PowerShellRunner,
} from '../electron/windows-credentials'

const legacy = {
  encrypt: () => {
    throw new Error('Legacy encryption must not be used')
  },
  decrypt: (value: string) => {
    if (value !== 'legacy-fixture') throw new Error('Invalid legacy data')
    return 'old-key'
  },
}

function profile() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'modelbridge-dpapi-'))
}

test('concurrent requests share one PowerShell launch and failures stay per record', async () => {
  const directory = profile()
  const inputs: string[] = []
  const run: PowerShellRunner = (_script, input) => {
    inputs.push(input)
    const lines = input
      .trim()
      .split('\n')
      .map((line) =>
        line.endsWith('cmVqZWN0') ? '-' : (
          `+${Buffer.from(line.slice(2), 'base64').reverse().toString('base64')}`
        ),
      )
    return Promise.resolve({ status: 0, stdout: `${lines.join('\n')}\n` })
  }
  try {
    const codec = windowsCredentialCodec(directory, legacy, { run })
    const [first, second] = await Promise.all([
      codec.encrypt('first-key'),
      codec.encrypt('second-key'),
    ])
    expect(inputs).toHaveLength(1)
    expect(first).toStartWith('modelbridge-dpapi-v1:')
    expect(codec.isCurrent?.(first)).toBe(true)
    expect(codec.isCurrent?.('legacy-fixture')).toBe(false)
    const results = await Promise.allSettled([
      codec.decrypt(first),
      codec.decrypt(second),
      codec.decrypt('modelbridge-dpapi-v1:cmVqZWN0'),
      codec.decrypt('modelbridge-dpapi-v1:not base64!'),
      codec.decrypt('legacy-fixture'),
    ])
    expect(inputs).toHaveLength(2)
    expect(results.map((item) => item.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'rejected',
      'rejected',
      'fulfilled',
    ])
    expect(
      results.flatMap((item) =>
        item.status === 'fulfilled' ? item.value : [],
      ),
    ).toEqual(['first-key', 'second-key', 'old-key'])
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('PowerShell failures, short responses and timeouts reject every waiting request without hanging', async () => {
  const directory = profile()
  let mode: 'exit' | 'short' | 'throw' = 'exit'
  let running = 0
  let overlapping = false
  const run: PowerShellRunner = async (_script, input) => {
    running++
    if (running > 1) overlapping = true
    await new Promise((resolve) => setTimeout(resolve, 5))
    running--
    if (mode === 'throw') throw new Error('timed out')
    if (mode === 'short') return { status: 0, stdout: '+AAAA\n' }
    return { status: 1, stdout: input }
  }
  try {
    const codec = windowsCredentialCodec(directory, legacy, { run })
    await expect(codec.encrypt('value')).rejects.toThrow(
      'Windows protected credential protect failed',
    )
    mode = 'short'
    const short = await Promise.allSettled([
      codec.encrypt('one'),
      codec.encrypt('two'),
    ])
    expect(short.every((item) => item.status === 'rejected')).toBe(true)
    mode = 'throw'
    const first = codec.decrypt('modelbridge-dpapi-v1:AAAA')
    await new Promise((resolve) => setImmediate(resolve))
    const queued = codec.decrypt('modelbridge-dpapi-v1:BBBB')
    await expect(first).rejects.toThrow('unprotect failed')
    await expect(queued).rejects.toThrow('unprotect failed')
    expect(overlapping).toBe(false)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test.skipIf(process.platform !== 'win32')(
  'a stalled PowerShell is terminated at its deadline',
  async () => {
    const started = Date.now()
    await expect(
      runPowerShell('Start-Sleep -Seconds 20', '', 1500),
    ).rejects.toThrow('did not respond within')
    expect(Date.now() - started).toBeLessThan(10_000)
  },
  20_000,
)

test.skipIf(process.platform !== 'win32')(
  'Windows protected credentials decrypt in another process context, bind to their profile, and preserve legacy decryption without plaintext storage',
  async () => {
    const directory = profile()
    try {
      const codec = windowsCredentialCodec(directory, legacy)
      const encrypted = await codec.encrypt('synthetic-local-key')
      expect(encrypted).toStartWith('modelbridge-dpapi-v1:')
      expect(encrypted).not.toContain('synthetic-local-key')
      expect(await codec.decrypt(encrypted)).toBe('synthetic-local-key')
      expect(
        await windowsCredentialCodec(directory, legacy).decrypt(encrypted),
      ).toBe('synthetic-local-key')
      await expect(
        windowsCredentialCodec(
          path.join(directory, 'other-profile'),
          legacy,
        ).decrypt(encrypted),
      ).rejects.toThrow('Windows protected credential')
      expect(await codec.decrypt('legacy-fixture')).toBe('old-key')
      await expect(
        codec.decrypt('modelbridge-dpapi-v1:invalid'),
      ).rejects.toThrow('Windows protected credential')
      const many = await Promise.all(
        Array.from({ length: 5 }, (_, index) => codec.encrypt(`key-${index}`)),
      )
      expect(
        await Promise.all(many.map((value) => codec.decrypt(value))),
      ).toEqual(Array.from({ length: 5 }, (_, index) => `key-${index}`))
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
  60_000,
)
