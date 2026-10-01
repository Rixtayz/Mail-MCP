import { createRequire } from "node:module";

// package.json sits one level above both src/ and dist/, and npm always ships it.
export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

// Works for npx users and clones alike; `npm run login` only works inside a clone.
export const LOGIN_COMMAND = "npx -y @rixtay/mail-mcp login";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const CHARACTER_LIMIT = 25_000;
export const BATCH_SIZE = 20;
export const MAX_RETRIES = 5;
export const PAGE_SIZE_SCAN = 1000;
export const SCOPES = ["Mail.ReadWrite", "Mail.Send", "User.Read"];
export const AUTHORITY = "https://login.microsoftonline.com/consumers";
