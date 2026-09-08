#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildServer } from "./server.js";

// stdout is reserved for JSON-RPC; everything else goes to stderr.
console.log = (...args: unknown[]) => console.error(...args);

serveStdio(() => buildServer());
