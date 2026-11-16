import { PublicClientApplication, type AccountInfo, type ICachePlugin, type TokenCacheContext } from "@azure/msal-node";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AUTHORITY, DEFAULT_CLIENT_ID, LOGIN_COMMAND, SCOPES } from "./constants.js";

export class AuthError extends Error {}

export function cachePath(): string {
  return process.env.MAIL_MCP_CACHE_PATH ?? join(homedir(), ".mail-mcp", "token-cache.json");
}

/**
 * The user's own Entra client ID when MAIL_MCP_CLIENT_ID is set; otherwise the built-in one.
 * Unset, empty, whitespace-only, or an unsubstituted `${...}` placeholder (Claude Desktop passes that when the field is left blank) counts as unset.
 */
export function clientId(): string {
  const id = (process.env.MAIL_MCP_CLIENT_ID ?? "").trim();
  if (id === "" || id.startsWith("${")) return DEFAULT_CLIENT_ID;
  return id;
}

/** Persists the MSAL token cache to a 0600 JSON file. */
export class FileCachePlugin implements ICachePlugin {
  constructor(private readonly path: string) {}

  async beforeCacheAccess(ctx: TokenCacheContext): Promise<void> {
    try {
      const data = await readFile(this.path, "utf8");
      ctx.tokenCache.deserialize(data);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  async afterCacheAccess(ctx: TokenCacheContext): Promise<void> {
    if (!ctx.cacheHasChanged) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, ctx.tokenCache.serialize(), { mode: 0o600 });
    await chmod(this.path, 0o600);
  }
}

let pca: PublicClientApplication | undefined;

export function getClient(): PublicClientApplication {
  if (!pca) {
    pca = new PublicClientApplication({
      auth: { clientId: clientId(), authority: AUTHORITY },
      cache: { cachePlugin: new FileCachePlugin(cachePath()) },
    });
  }
  return pca;
}

export async function getAccount(): Promise<AccountInfo | undefined> {
  const accounts = await getClient().getTokenCache().getAllAccounts();
  return accounts[0];
}

/** Silent token acquisition. Throws AuthError with an actionable message when login is required. */
export async function getAccessToken(): Promise<string> {
  const account = await getAccount();
  if (!account) {
    throw new AuthError(
      `No account is signed in. Ask the user to run \`${LOGIN_COMMAND}\` once, with the same MAIL_MCP_CLIENT_ID, to sign in to their Outlook.com account.`,
    );
  }
  try {
    const result = await getClient().acquireTokenSilent({ account, scopes: SCOPES });
    return result.accessToken;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AuthError(`Token expired or invalid (${msg.split("\n")[0]}). Ask the user to run \`${LOGIN_COMMAND}\` again.`);
  }
}

/** Interactive login through the system browser (auth code + PKCE, localhost loopback). */
export async function loginInteractive(openBrowser: (url: string) => Promise<void>): Promise<AccountInfo> {
  const result = await getClient().acquireTokenInteractive({
    scopes: SCOPES,
    openBrowser,
    successTemplate: "<h2>Mail-MCP is connected.</h2><p>You can close this tab.</p>",
    errorTemplate: "<h2>Mail-MCP sign-in failed.</h2><p>Go back to the terminal.</p>",
  });
  if (!result.account) throw new AuthError("Sign-in did not return an account.");
  return result.account;
}
