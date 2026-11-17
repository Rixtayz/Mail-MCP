import { createRequire } from "node:module";

// package.json sits one level above both src/ and dist/, and npm always ships it.
export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const CHARACTER_LIMIT = 25_000;
export const BATCH_SIZE = 20;
export const MAX_RETRIES = 5;
export const PAGE_SIZE_SCAN = 1000;
export const SCOPES = ["Mail.ReadWrite"];
export const AUTHORITY = "https://login.microsoftonline.com/consumers";
// Application (client) ID of the built-in Mail-MCP Entra app, used when MAIL_MCP_CLIENT_ID is unset.
export const DEFAULT_CLIENT_ID = "599bb072-c4e2-42b1-b4e5-1d901fc08c66";
// How long mail_login waits for the user to finish signing in before answering "pending": under a 60 s client timeout.
export const LOGIN_WAIT_MS = 45_000;
// An unfinished browser sign-in is abandoned after this long, which frees its loopback port.
export const LOGIN_GIVE_UP_MS = 300_000;
// Where a user withdraws an app's access to their Microsoft account; Microsoft prints it on the consent screen.
export const CONSENT_URL = "https://microsoft.com/consent";
