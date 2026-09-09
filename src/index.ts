#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { runLogin } from "./login.js";
import { buildServer } from "./server.js";

// stdout is reserved for JSON-RPC; everything else goes to stderr.
console.log = (...args: unknown[]) => console.error(...args);

const command = process.argv[2];

if (command === "login") {
  runLogin().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else if (command === "--help" || command === "-h" || command === "help") {
  console.error("Usage:\n  mail-mcp          start the MCP server on stdio\n  mail-mcp login    sign in to your Microsoft account once (needs MAIL_MCP_CLIENT_ID)");
} else {
  serveStdio(() => buildServer());
}
