import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { windowsCredentialCodec } from '../electron/windows-credentials'

test.skipIf(process.platform !== 'win32')(
  'Windows protected credentials decrypt in another process context, bind to their profile, and preserve legacy decryption without plaintext storage',
  () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'modelbridge-dpapi-'),
    )
    const legacy = {
      encrypt: () => {
        throw new Error('Legacy encryption must not be used')
      },
      decrypt: (value: string) => {
        if (value !== 'legacy-fixture') throw new Error('Invalid legacy data')
        return 'old-key'
      },
    }
    try {
      const codec = windowsCredentialCodec(directory, legacy)
      const encrypted = codec.encrypt('synthetic-local-key')
      expect(encrypted).toStartWith('modelbridge-dpapi-v1:')
      expect(encrypted).not.toContain('synthetic-local-key')
      expect(codec.decrypt(encrypted)).toBe('synthetic-local-key')
      expect(windowsCredentialCodec(directory, legacy).decrypt(encrypted)).toBe(
        'synthetic-local-key',
      )
      expect(
        windowsCredentialCodec(
          path.join(directory, 'other-profile'),
          legacy,
        ).decrypt.bind(null, encrypted),
      ).toThrow('Windows protected credential')
      expect(codec.decrypt('legacy-fixture')).toBe('old-key')
      expect(() => codec.decrypt('modelbridge-dpapi-v1:invalid')).toThrow(
        'Windows protected credential',
      )
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
  60_000,
)
