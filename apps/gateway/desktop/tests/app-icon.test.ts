import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url))

describe('application icon assets', () => {
  test('uses the same vector artwork in the header and sign-in screen', () => {
    for (const file of [
      '../src/components/Header.tsx',
      '../src/pages/AuthPage.tsx',
    ]) {
      const source = read(file).toString()
      expect(source).toContain('../../assets/app-icon.svg')
      expect(source).toContain('src={appIconUrl}')
      expect(source).not.toContain('>CA</span>')
    }
  })

  test('includes a PNG frame for every Windows taskbar size', () => {
    const ico = read('../build/icon.ico')
    const sizes = [16, 20, 24, 32, 40, 48, 64, 256]
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(sizes.length)
    let nextOffset = 6 + sizes.length * 16
    sizes.forEach((size, index) => {
      const entry = 6 + index * 16
      expect(ico[entry] || 256).toBe(size)
      expect(ico[entry + 1] || 256).toBe(size)
      expect(ico.readUInt16LE(entry + 6)).toBe(32)
      const length = ico.readUInt32LE(entry + 8)
      const offset = ico.readUInt32LE(entry + 12)
      expect(offset).toBe(nextOffset)
      const png = ico.subarray(offset, offset + length)
      expect(png.subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      )
      expect(png.readUInt32BE(16)).toBe(size)
      expect(png.readUInt32BE(20)).toBe(size)
      nextOffset += length
    })
    expect(nextOffset).toBe(ico.length)
  })

  test('ships high-resolution window and small tray PNGs', () => {
    for (const [file, size] of [
      ['../assets/icon.png', 1024],
      ['../assets/tray-icon.png', 16],
      ['../assets/tray-icon@2x.png', 32],
    ] as const) {
      const png = read(file)
      expect(png.readUInt32BE(16)).toBe(size)
      expect(png.readUInt32BE(20)).toBe(size)
    }
  })
})
