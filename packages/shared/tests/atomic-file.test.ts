import { afterEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { writeFileAtomically } from "@copilot-api/shared/atomic-file"

const tempDirs: Array<string> = []

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-file-"))
  tempDirs.push(tempDir)
  return tempDir
}

function listTempFiles(directory: string): Array<string> {
  return fs
    .readdirSync(directory)
    .filter(
      (entry) => entry.startsWith(".config.json.") && entry.endsWith(".tmp"),
    )
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe("writeFileAtomically", () => {
  test.each(["success", "open", "fsync", "close"])(
    "keeps a committed write when directory durability ends at %s",
    (failure) => {
      const directory = createTempDir()
      const filePath = path.join(directory, "config.json")
      const platform = Object.getOwnPropertyDescriptor(process, "platform")
      if (!platform) throw new Error("Missing process platform descriptor")
      const directoryFd = 424242
      const originalOpen = fs.openSync
      const originalFsync = fs.fsyncSync
      const originalClose = fs.closeSync
      const open = spyOn(fs, "openSync").mockImplementation(
        (target, flags, mode) => {
          if (target !== directory) return originalOpen(target, flags, mode)
          if (failure === "open") throw new Error("directory open failed")
          return directoryFd
        },
      )
      const sync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (fd !== directoryFd) return originalFsync(fd)
        if (failure === "fsync") throw new Error("directory fsync failed")
      })
      const close = spyOn(fs, "closeSync").mockImplementation((fd) => {
        if (fd !== directoryFd) return originalClose(fd)
        if (failure === "close") throw new Error("directory close failed")
      })
      const warning = spyOn(console, "warn").mockImplementation(() => {})

      try {
        Object.defineProperty(process, "platform", { value: "linux" })
        writeFileAtomically(filePath, "new")
        expect(fs.readFileSync(filePath, "utf8")).toBe("new")
        expect(listTempFiles(directory)).toEqual([])
        expect(warning).toHaveBeenCalledTimes(
          failure === "open" || failure === "fsync" ? 1 : 0,
        )
        if (failure !== "open") expect(close).toHaveBeenCalledWith(directoryFd)
      } finally {
        Object.defineProperty(process, "platform", platform)
        open.mockRestore()
        sync.mockRestore()
        close.mockRestore()
        warning.mockRestore()
      }
    },
  )

  test("replaces an existing file without leaving a temporary file", () => {
    const tempDir = createTempDir()
    const filePath = path.join(tempDir, "config.json")
    fs.writeFileSync(filePath, "old", "utf8")

    writeFileAtomically(filePath, "new")

    expect(fs.readFileSync(filePath, "utf8")).toBe("new")
    expect(listTempFiles(tempDir)).toEqual([])
  })

  test("preserves the target when writing the temporary file fails", () => {
    const tempDir = createTempDir()
    const filePath = path.join(tempDir, "config.json")
    fs.writeFileSync(filePath, "old", "utf8")
    const originalWriteFileSync = fs.writeFileSync
    fs.writeFileSync = (target, ...args) => {
      if (typeof target === "number") {
        throw new Error("forced temporary write failure")
      }
      return Reflect.apply(originalWriteFileSync, fs, [target, ...args])
    }

    try {
      expect(() => writeFileAtomically(filePath, "new")).toThrow(
        "forced temporary write failure",
      )
    } finally {
      fs.writeFileSync = originalWriteFileSync
    }

    expect(fs.readFileSync(filePath, "utf8")).toBe("old")
    expect(listTempFiles(tempDir)).toEqual([])
  })

  test("preserves the target when the atomic replacement fails", () => {
    const tempDir = createTempDir()
    const filePath = path.join(tempDir, "config.json")
    fs.writeFileSync(filePath, "old", "utf8")
    const originalRenameSync = fs.renameSync
    fs.renameSync = () => {
      throw new Error("forced atomic replacement failure")
    }

    try {
      expect(() => writeFileAtomically(filePath, "new")).toThrow(
        "forced atomic replacement failure",
      )
    } finally {
      fs.renameSync = originalRenameSync
    }

    expect(fs.readFileSync(filePath, "utf8")).toBe("old")
    expect(listTempFiles(tempDir)).toEqual([])
  })
})
