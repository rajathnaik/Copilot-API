import { beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { createAuthMiddleware } from "~/lib/request-auth"

let regularApiKeys: Array<string>
let adminApiKeys: Array<string>

function createApp() {
  const app = new Hono()

  app.use(
    "*",
    createAuthMiddleware({
      getApiKeys: () => regularApiKeys,
      allowUnauthenticatedPaths: [],
      shouldSkipPath: (path) => path.startsWith("/admin/"),
    }),
  )
  app.use(
    "/admin/*",
    createAuthMiddleware({
      getApiKeys: () => adminApiKeys,
      allowUnauthenticatedPaths: [],
      allowWhenNoApiKeys: false,
    }),
  )

  app.all("/models", (c) => c.json({ ok: true, scope: "default" }))
  app.all("/admin/config/model-mappings", (c) =>
    c.json({ ok: true, scope: "admin" }),
  )

  return app
}

beforeEach(() => {
  regularApiKeys = ["regular-key"]
  adminApiKeys = ["admin-key"]
})

describe("request auth middleware", () => {
  test("accepts regular api keys for protected non-admin routes", async () => {
    const app = createApp()
    const response = await app.request("/models", {
      headers: {
        "x-api-key": "regular-key",
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, scope: "default" })
  })

  test("accepts admin api key for admin routes", async () => {
    const app = createApp()
    const response = await app.request("/admin/config/model-mappings", {
      headers: {
        authorization: "Bearer admin-key",
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, scope: "admin" })
  })

  test("rejects regular api keys on admin routes", async () => {
    const app = createApp()
    const response = await app.request("/admin/config/model-mappings", {
      headers: {
        "x-api-key": "regular-key",
      },
    })

    expect(response.status).toBe(401)
  })

  test("rejects admin api keys on protected non-admin routes", async () => {
    const app = createApp()
    const response = await app.request("/models", {
      headers: {
        "x-api-key": "admin-key",
      },
    })

    expect(response.status).toBe(401)
  })

  test("allows non-admin routes when no regular api keys are configured", async () => {
    regularApiKeys = []
    const app = createApp()
    const response = await app.request("/models")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, scope: "default" })
  })

  test("rejects admin routes when no admin api key is configured", async () => {
    adminApiKeys = []
    const app = createApp()
    const response = await app.request("/admin/config/model-mappings")

    expect(response.status).toBe(401)
  })

  test("allows options requests for admin routes without auth", async () => {
    const app = createApp()
    const response = await app.request("/admin/config/model-mappings", {
      method: "OPTIONS",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, scope: "admin" })
  })
})
