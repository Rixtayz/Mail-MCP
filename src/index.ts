#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { VERSION } from "./constants.js";
import { logout } from "./auth.js";
import { runLogin } from "./login.js";
import { buildServer } from "./server.js";
import { logoutDetail } from "./tools/session.js";

// stdout is reserved for JSON-RPC; everything else goes to stderr.
console.log = (...args: unknown[]) => console.error(...args);

const command = process.argv[2];

if (command === "login") {
  runLogin().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
} else if (command === "logout") {
  logout().then(
    ({ account, notRemoved }) => console.error(logoutDetail(account, notRemoved)),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
} else if (command === "--version" || command === "-v") {
  console.error(VERSION);
} else if (command === "--help" || command === "-h" || command === "help") {
  console.error(
    "Usage:\n  mail-mcp            start the MCP server on stdio\n  mail-mcp login      sign in to your Microsoft account (the assistant can also do it with the mail_login tool)\n  mail-mcp logout     sign out and remove the stored sign-in\n  mail-mcp --version  print the version",
  );
} else {
  serveStdio(() => buildServer());
}
