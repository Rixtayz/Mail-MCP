import { PublicClientApplication, type AccountInfo, type ICachePlugin, type TokenCacheContext } from "@azure/msal-node";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AUTHORITY, DEFAULT_CLIENT_ID, SCOPES } from "./constants.js";

export class AuthError extends Error {}

const NOT_SIGNED_IN = "Not signed in. Call the mail_login tool to sign the user in.";
const SIGN_IN_EXPIRED = "The sign-in has expired. Call the mail_login tool to sign the user in again.";

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
  /** True once this instance has read or written the file, until it finds the file gone. */
  private seenFile = false;

  constructor(private readonly path: string) {}

  async beforeCacheAccess(ctx: TokenCacheContext): Promise<void> {
    let data: string;
    try {
      data = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // Never seen a file: nobody has signed in yet, and a first sign-in may be saving its tokens right now,
      // between its own read and its write. Keep what MSAL holds, or that write would save an empty cache.
      if (!this.seenFile) return;
      // The file this instance knew is gone: another process signed out. MSAL must not keep what it holds in
      // memory, or the next write would bring the signed-out account back. deserialize() only merges into the
      // in-memory store, so empty the store itself, then drop the snapshot the next write merges with.
      this.seenFile = false;
      const store = (ctx.tokenCache as unknown as { getKVStore?: () => Record<string, unknown> }).getKVStore?.();
      if (store) for (const key of Object.keys(store)) delete store[key];
      ctx.tokenCache.deserialize("");
      return;
    }
    try {
      ctx.tokenCache.deserialize(data);
      this.seenFile = true;
    } catch {
      // Unparseable. Never rethrow: JSON.parse quotes the text around the fault, which could be part of a token.
      // MSAL kept the bad text as its snapshot before parsing it, and serialize() would parse it again on the
      // next write; "" empties that snapshot and leaves the in-memory cache as it is, so the next write
      // replaces the file with valid JSON.
      ctx.tokenCache.deserialize("");
    }
  }

  async afterCacheAccess(ctx: TokenCacheContext): Promise<void> {
    if (!ctx.cacheHasChanged) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, ctx.tokenCache.serialize(), { mode: 0o600 });
    this.seenFile = true;
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

/** Drops the cached MSAL client, so the next call starts from an empty in-memory cache and re-reads the client ID and cache path. */
export function resetClient(): void {
  pca = undefined;
}

export async function getAccount(): Promise<AccountInfo | undefined> {
  const accounts = await getClient().getTokenCache().getAllAccounts();
  // MSAL reads the name from an ID token of this client ID; an account left by another client ID has "" and no
  // token this client can use. Prefer the one this client signed in, as mail_login and logout() do.
  return accounts.find((a) => a.username !== "") ?? accounts[0];
}

/** Silent token acquisition. Throws AuthError with an actionable message when login is required. */
export async function getAccessToken(): Promise<string> {
  const account = await getAccount();
  if (!account) throw new AuthError(NOT_SIGNED_IN);
  try {
    const result = await getClient().acquireTokenSilent({ account, scopes: SCOPES });
    return result.accessToken;
  } catch {
    throw new AuthError(SIGN_IN_EXPIRED);
  }
}

/**
 * The signed-in username, if a token can be had without the user. A cached account alone is not enough:
 * a cache written under another client ID lists the account but holds no token this client can use.
 * Never throws.
 */
export async function signedInAccount(): Promise<string | undefined> {
  try {
    const account = await getAccount();
    if (!account) return undefined;
    const result = await getClient().acquireTokenSilent({ account, scopes: SCOPES });
    return result.account?.username || account.username;
  } catch {
    return undefined;
  }
}

/** Removes every account from the MSAL cache and deletes the cache file. Returns the account that was there, if any. */
export async function logout(): Promise<{ account?: string }> {
  let account: string | undefined;
  try {
    const cache = getClient().getTokenCache();
    const accounts = await cache.getAllAccounts();
    // MSAL reads the name from an ID token of this client ID; a cache from another client ID leaves it "".
    account = accounts.find((a) => a.username !== "")?.username;
    for (const a of accounts) await cache.removeAccount(a);
  } finally {
    resetClient();
    await rm(cachePath(), { force: true });
  }
  return account === undefined ? {} : { account };
}

/** Interactive login through the system browser (auth code + PKCE, localhost loopback). */
export async function loginInteractive(openBrowser: (url: string) => Promise<void>): Promise<AccountInfo> {
  const result = await getClient().acquireTokenInteractive({
    scopes: SCOPES,
    prompt: "select_account",
    openBrowser,
    // MSAL 7 serves these without a Content-Type, so they must read well as plain text.
    successTemplate: "Mail-MCP is connected. You can close this tab.",
    errorTemplate: "Mail-MCP sign-in failed. Go back to Claude and try again.",
  });
  if (!result.account) throw new AuthError("Sign-in did not return an account.");
  return result.account;
}
