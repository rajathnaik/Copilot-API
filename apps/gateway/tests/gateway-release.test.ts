import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import gateway from "../package.json"
import desktop from "../desktop/package.json"
import {
  gatewayReleaseMetadata,
  writeGatewayReleaseOutputs,
} from "../scripts/gateway-release"

const source = {
  eventName: "push",
  refType: "tag",
  refName: `v${gateway.version}`,
}

describe("approved Gateway installer releases", () => {
  test("accepts only the matching private Gateway product and tag", () => {
    expect(gatewayReleaseMetadata(gateway, desktop, source)).toEqual({
      version: gateway.version,
      tag: source.refName,
    })
    for (const input of [
      { ...source, refType: "branch" },
      { ...source, refName: `connector-v${gateway.version}` },
      { ...source, refName: "v0.0.0" },
      { ...source, eventName: "pull_request" },
    ])
      expect(() => gatewayReleaseMetadata(gateway, desktop, input)).toThrow()
    expect(() => gatewayReleaseMetadata({}, desktop, source)).toThrow("Gateway")
    expect(() => gatewayReleaseMetadata(gateway, {}, source)).toThrow("Gateway")
    expect(() =>
      gatewayReleaseMetadata(gateway, { ...desktop, version: "0.0.0" }, source),
    ).toThrow("matching stable versions")
    for (const version of ["02.7.0", "2.7", "2.7.0-beta.1", null])
      expect(() =>
        gatewayReleaseMetadata({ ...gateway, version }, desktop, source),
      ).toThrow("matching stable versions")
  })

  test("writes validated outputs and requires an Actions output path", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-release-"))
    try {
      const output = path.join(directory, "outputs")
      const env = {
        GITHUB_EVENT_NAME: source.eventName,
        GITHUB_REF_TYPE: source.refType,
        GITHUB_REF_NAME: source.refName,
        GITHUB_OUTPUT: output,
      }
      writeGatewayReleaseOutputs(env)
      expect(fs.readFileSync(output, "utf8")).toBe(
        `version=${gateway.version}\ntag=${source.refName}\n`,
      )
      expect(() =>
        writeGatewayReleaseOutputs({ ...env, GITHUB_OUTPUT: "" }),
      ).toThrow("output path")
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
