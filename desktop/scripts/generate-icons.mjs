import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../assets/app-icon.svg', import.meta.url))
const outputPath = (relative) =>
  fileURLToPath(new URL(relative, import.meta.url))

function render(size) {
  const result = spawnSync(
    'rsvg-convert',
    ['-w', String(size), '-h', String(size), source],
    { maxBuffer: 10 * 1024 * 1024 },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr.toString() || 'Icon rendering failed')
  }
  return result.stdout
}

writeFileSync(outputPath('../assets/icon.png'), render(1024))
writeFileSync(outputPath('../assets/tray-icon.png'), render(16))
writeFileSync(outputPath('../assets/tray-icon@2x.png'), render(32))

const sizes = [16, 20, 24, 32, 40, 48, 64, 256]
const frames = sizes.map(render)
const header = Buffer.alloc(6 + sizes.length * 16)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = header.length
frames.forEach((frame, index) => {
  const entry = 6 + index * 16
  header[entry] = sizes[index] === 256 ? 0 : sizes[index]
  header[entry + 1] = header[entry]
  header.writeUInt16LE(1, entry + 4)
  header.writeUInt16LE(32, entry + 6)
  header.writeUInt32LE(frame.length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += frame.length
})
writeFileSync(
  outputPath('../build/icon.ico'),
  Buffer.concat([header, ...frames]),
)
