import { PublicClientApplication, type AccountInfo, type ICachePlugin, type TokenCacheContext } from "@azure/msal-node";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { AUTHORITY, DEFAULT_CLIENT_ID, SCOPES } from "./constants.js";

export class AuthError extends Error {}

const NOT_SIGNED_IN = "Not signed in. Call the mail_login tool to sign the user in.";
const SIGN_IN_EXPIRED = "The sign-in has expired. Call the mail_login tool to sign the user in again.";

function defaultCachePath(): string {
  return join(homedir(), ".mail-mcp", "token-cache.json");
}

/**
 * The token cache file: MAIL_MCP_CACHE_PATH when it holds an absolute path, otherwise ~/.mail-mcp/token-cache.json.
 * Unset, empty, whitespace-only, or an unsubstituted `${...}` placeholder counts as unset, as for MAIL_MCP_CLIENT_ID.
 * A relative path is refused: it would depend on the folder the client happens to start the server in.
 */
export function cachePath(): string {
  const path = (process.env.MAIL_MCP_CACHE_PATH ?? "").trim();
  if (path === "" || path.startsWith("${")) return defaultCachePath();
  if (!isAbsolute(path)) {
    throw new AuthError(
      "MAIL_MCP_CACHE_PATH is not an absolute path. Set it to a full path (a leading ~ is not expanded), or leave it empty to use ~/.mail-mcp/token-cache.json.",
    );
  }
  return path;
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
  /** True when the file sits in the default ~/.mail-mcp, a folder Mail-MCP owns and may make private. */
  private readonly inDefaultFolder: boolean;

  constructor(private readonly path: string) {
    this.inDefaultFolder = resolve(dirname(path)) === resolve(dirname(defaultCachePath()));
  }

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
    const folder = dirname(this.path);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await checkCacheFolder(folder, this.inDefaultFolder);
    await replaceFile(this.path, ctx.tokenCache.serialize());
    this.seenFile = true;
  }
}

/**
 * On macOS and Linux, refuses a cache folder that belongs to another user or that other users can write to:
 * they could replace the file, or read the tokens through a file of their own. The default ~/.mail-mcp is made
 * private (0700) first. Windows does not use these modes: the folder's own permissions apply, as before (storing
 * the tokens in the system keychain is planned for 0.4).
 */
async function checkCacheFolder(folder: string, makePrivate: boolean): Promise<void> {
  if (process.platform === "win32") return;
  let info = await stat(folder);
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new AuthError(
      `The sign-in was not saved: the folder ${folder} belongs to another user. Set MAIL_MCP_CACHE_PATH to a file in a folder of your own.`,
    );
  }
  if (makePrivate && (info.mode & 0o077) !== 0) {
    await chmod(folder, 0o700);
    info = await stat(folder);
  }
  if ((info.mode & 0o022) !== 0) {
    throw new AuthError(
      `The sign-in was not saved: other users can write to the folder ${folder}. Make it private (chmod 700), or set MAIL_MCP_CACHE_PATH to a file in a private folder.`,
    );
  }
}

/**
 * Writes data to a new 0600 file next to path, then renames it over path. A symlink at path is replaced, never
 * followed, and a reader never sees half a file. The temporary file is removed if anything fails.
 */
async function replaceFile(path: string, data: string): Promise<void> {
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temp, data, { flag: "wx", mode: 0o600 });
    await renameOver(temp, path);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

/** rename(), retried briefly on Windows, which refuses to replace a file another program (an antivirus scan, a backup) holds open. */
async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const busy = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (process.platform !== "win32" || !busy || attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
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
