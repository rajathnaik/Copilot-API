import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const connector = process.argv.includes('--connector')
const source = fileURLToPath(
  new URL(
    connector || process.argv.includes('--render-connector') ?
      '../assets/connector-icon.svg'
    : '../assets/app-icon.svg',
    import.meta.url,
  ),
)
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

const sizes = [16, 20, 24, 32, 40, 48, 64, 256]
let frames
if (process.versions.electron && process.argv.includes('--render-connector')) {
  const { app, BrowserWindow } = createRequire(import.meta.url)('electron')
  const directory = process.argv[process.argv.indexOf('--render-connector') + 1]
  app.setPath('userData', directory)
  app.setPath('sessionData', directory)
  app.commandLine.appendSwitch('disable-gpu')
  void app
    .whenReady()
    .then(async () => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: { sandbox: true, contextIsolation: true },
      })
      await window.loadURL('about:blank')
      const data = `data:image/svg+xml;base64,${readFileSync(source).toString('base64')}`
      const images = await window.webContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = ${JSON.stringify(data)};
      await image.decode();
      return ${JSON.stringify([1024, ...sizes])}.map(size => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        canvas.getContext('2d').drawImage(image, 0, 0, size, size);
        return canvas.toDataURL('image/png').split(',')[1];
      });
    })()`)
      process.stdout.write(JSON.stringify(images), () => app.quit())
    })
    .catch((error) => {
      process.stderr.write(error.message)
      app.exit(1)
    })
} else {
  if (connector) {
    const directory = mkdtempSync(join(tmpdir(), 'connector-icons-'))
    try {
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const result = spawnSync(
        createRequire(import.meta.url)('electron'),
        [fileURLToPath(import.meta.url), '--render-connector', directory],
        { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
      )
      if (result.error) throw result.error
      if (result.status !== 0)
        throw new Error(result.stderr || 'Connector icon rendering failed.')
      const images = JSON.parse(result.stdout)
      if (
        !Array.isArray(images)
        || images.length !== sizes.length + 1
        || images.some((image) => typeof image !== 'string')
      )
        throw new Error('Connector icon renderer returned invalid images.')
      const [large, ...small] = images.map((image) =>
        Buffer.from(image, 'base64'),
      )
      writeFileSync(outputPath('../assets/connector-icon.png'), large)
      frames = small
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  } else {
    writeFileSync(outputPath('../assets/icon.png'), render(1024))
    writeFileSync(outputPath('../assets/tray-icon.png'), render(16))
    writeFileSync(outputPath('../assets/tray-icon@2x.png'), render(32))
    frames = sizes.map(render)
  }
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
    outputPath(connector ? '../build/connector-icon.ico' : '../build/icon.ico'),
    Buffer.concat([header, ...frames]),
  )
}
