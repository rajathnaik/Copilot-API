#!/usr/bin/env node

import { defineCommand } from "citty"

import { MCP_SUBCOMMAND } from "./lib/fast-path"
import { runMcpServer } from "./lib/mcp-server"

export const mcp = defineCommand({
  meta: {
    name: MCP_SUBCOMMAND,
    description: "Start the Copilot API MCP tool_search bridge over stdio",
  },
  run() {
    return runMcpServer()
  },
})
