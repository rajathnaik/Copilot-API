import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('..', import.meta.url))
const assets = path.join(root, 'apps', 'modelbridge', 'assets')
if (process.argv.includes('--render')) {
  const { app, BrowserWindow } = require('electron')
  app.setPath('userData', process.argv[process.argv.indexOf('--render') + 1])
  void app
    .whenReady()
    .then(async () => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: { sandbox: true },
      })
      await window.loadURL('about:blank')
      const svg = fs
        .readFileSync(path.join(assets, 'icon.svg'))
        .toString('base64')
      const images = await window.webContents.executeJavaScript(`(async () => {
      const image = new Image(); image.src = "data:image/svg+xml;base64,${svg}"; await image.decode();
      return [16, 256].map(size => {
        const canvas = document.createElement("canvas"); canvas.width = canvas.height = size;
        canvas.getContext("2d").drawImage(image, 0, 0, size, size);
        return canvas.toDataURL("image/png").split(",")[1];
      });
    })()`)
      process.stdout.write(JSON.stringify(images), () => app.quit())
    })
    .catch((error) => {
      console.error(error)
      app.exit(1)
    })
} else {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'modelbridge-icon-'))
  try {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const output = execFileSync(
      require('electron'),
      [fileURLToPath(import.meta.url), '--render', directory],
      { env, encoding: 'utf8', timeout: 30_000 },
    )
    const images = JSON.parse(output)
    if (
      !Array.isArray(images)
      || images.length !== 2
      || !images.every((value) => typeof value === 'string')
    )
      throw new Error('Icon rendering returned invalid image data.')
    const [tray, icon] = images.map((value) => Buffer.from(value, 'base64'))
    fs.writeFileSync(path.join(assets, 'tray.png'), tray)
    fs.writeFileSync(path.join(assets, 'icon.png'), icon)
    const header = Buffer.alloc(22)
    header.writeUInt16LE(1, 2)
    header.writeUInt16LE(1, 4)
    header.writeUInt16LE(1, 10)
    header.writeUInt16LE(32, 12)
    header.writeUInt32LE(icon.length, 14)
    header.writeUInt32LE(22, 18)
    fs.writeFileSync(
      path.join(assets, 'icon.ico'),
      Buffer.concat([header, icon]),
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
