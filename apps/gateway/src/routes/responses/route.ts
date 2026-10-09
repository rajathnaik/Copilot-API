import { Hono } from "hono"

import { forwardError } from "~/lib/error"
import { zstdDecompressionMiddleware } from "~/lib/zstd-request"

import { handleResponses } from "./handler"

export const responsesRoutes = new Hono()

responsesRoutes.use(zstdDecompressionMiddleware)

responsesRoutes.post("/", async (c) => {
  try {
    return await handleResponses(c)
  } catch (error) {
    return await forwardError(c, error)
  }
})
