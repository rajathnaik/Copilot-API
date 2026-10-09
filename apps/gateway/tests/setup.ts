import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Redirect handler file logs to a throwaway directory so test runs never
// write into the real application log directory.
process.env.COPILOT_API_LOG_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "copilot-api-test-logs-"),
)
