import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

// The installer writes both; see installer/data-folder.nsh.
export const pointerFile = 'data-location.txt'
export const registryKey = 'HKCU\\Software\\ModelBridge'
export const registryValue = 'DataDir'

// Files ModelBridge cannot run without. Everything else in the profile is
// Chromium cache or logs that are regenerated when missing.
const essential = new Set(['state.json', 'credentials.json', 'usage', 'codex'])

/** Reads the data folder recorded beside the installed executable, if any. */
export function readDataLocation(installDir: string): string | null {
  let raw: Buffer
  try {
    raw = fs.readFileSync(path.join(installDir, pointerFile))
  } catch {
    return null
  }
  const text =
    raw[0] === 0xff && raw[1] === 0xfe ?
      raw.subarray(2).toString('utf16le')
    : raw.toString('utf8').replace(/^\uFEFF/u, '')
  const value = text.trim()
  return value && path.isAbsolute(value) ? path.resolve(value) : null
}

/** Writes the pointer the same way the installer does (UTF-16LE with BOM). */
export function writeDataLocation(installDir: string, dataDir: string): void {
  const file = path.join(installDir, pointerFile)
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(
    temporary,
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(dataDir, 'utf16le')]),
  )
  fs.renameSync(temporary, file)
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return (
    relative === ''
    || (!relative.startsWith('..') && !path.isAbsolute(relative))
  )
}

/** Returns the resolved target, or throws a message the user can act on. */
export function validateDataTarget(
  target: string,
  current: string,
  installDir: string,
): string {
  if (!target.trim() || !path.isAbsolute(target.trim()))
    throw new Error('Choose a full folder path for ModelBridge data.')
  const resolved = path.resolve(target.trim())
  if (path.parse(resolved).root === resolved)
    throw new Error('Choose a folder, not the root of a drive.')
  if (isInside(resolved, current) || isInside(current, resolved))
    throw new Error(
      'Choose a folder that is not the current data folder, inside it or containing it.',
    )
  if (isInside(resolved, installDir))
    throw new Error(
      'Choose a folder outside the install folder. Updates replace everything in the install folder.',
    )
  if (fs.existsSync(resolved)) {
    if (!fs.statSync(resolved).isDirectory())
      throw new Error('The chosen path is a file, not a folder.')
    if (fs.readdirSync(resolved).length)
      throw new Error(
        'Choose an empty folder so no existing files are overwritten.',
      )
  }
  return resolved
}

/**
 * Copies the profile into an empty target. Failures on essential files abort
 * the move; Chromium caches still locked by this process are skipped.
 */
export function copyProfile(from: string, to: string): string[] {
  fs.mkdirSync(to, { recursive: true })
  const skipped: string[] = []
  for (const entry of fs.readdirSync(from)) {
    if (entry === 'lockfile') continue
    try {
      fs.cpSync(path.join(from, entry), path.join(to, entry), {
        recursive: true,
        errorOnExist: true,
        force: false,
      })
    } catch (error) {
      if (essential.has(entry)) throw error
      skipped.push(entry)
    }
  }
  for (const entry of ['state.json', 'credentials.json'])
    if (fs.existsSync(path.join(from, entry)))
      if (
        !fs
          .readFileSync(path.join(from, entry))
          .equals(fs.readFileSync(path.join(to, entry)))
      )
        throw new Error(`${entry} did not copy correctly.`)
  return skipped
}

type Run = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean },
) => Promise<unknown>

/** Records the data folder for future installers and updates. */
export async function writeDataRegistry(
  dataDir: string,
  run: Run = promisify(execFile),
): Promise<void> {
  await run(
    'reg.exe',
    [
      'add',
      registryKey,
      '/v',
      registryValue,
      '/t',
      'REG_SZ',
      '/d',
      dataDir,
      '/f',
    ],
    { timeout: 15_000, windowsHide: true },
  )
}
