import { TokenCacheContext } from "@azure/msal-node";
import {
  chmodSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthError,
  FileCachePlugin,
  cachePath,
  clientId,
  getAccessToken,
  getClient,
  loginInteractive,
  logout,
  resetClient,
  signedInAccount,
} from "../src/auth.js";

// The real mkdir, writeFile and rename, wrapped so that a test can hold or fail a cache write at one of them,
// or see how it was called. Every other call passes through.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: vi.fn(actual.mkdir), writeFile: vi.fn(actual.writeFile), rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) };
});

const POSIX = process.platform !== "win32";
const mode = (p: string) => statSync(p).mode & 0o777;

// HOME (POSIX) and USERPROFILE (Windows) are what os.homedir() reads: the tests point them at a temporary folder.
const ENV_KEYS = ["MAIL_MCP_CLIENT_ID", "MAIL_MCP_CACHE_PATH", "HOME", "USERPROFILE"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetClient();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("clientId", () => {
  const OWN = "11111111-2222-3333-4444-555555555555";
  it.each([undefined, "", "   ", "${user_config.client_id}"])("falls back to the built-in ID for %j", (value) => {
    if (value === undefined) delete process.env.MAIL_MCP_CLIENT_ID; else process.env.MAIL_MCP_CLIENT_ID = value;
    expect(clientId()).toBe("599bb072-c4e2-42b1-b4e5-1d901fc08c66");
  });
  it("uses the user's own ID, trimmed", () => {
    process.env.MAIL_MCP_CLIENT_ID = ` ${OWN} `;
    expect(clientId()).toBe(OWN);
  });
});

/** A temporary home folder, so that os.homedir() and the default cache path never reach the real ~/.mail-mcp. */
function useTempHome(): { readonly home: string } {
  const state = { home: "" };
  beforeEach(() => {
    state.home = mkdtempSync(join(tmpdir(), "mail-mcp-home-"));
    process.env.HOME = state.home;
    process.env.USERPROFILE = state.home;
  });
  afterEach(() => {
    rmSync(state.home, { recursive: true, force: true });
  });
  return state;
}

describe("cachePath", () => {
  const temp = useTempHome();

  it.each([undefined, "", "   ", "${user_config.cache_path}"])("uses ~/.mail-mcp/token-cache.json for %j", (value) => {
    if (value === undefined) delete process.env.MAIL_MCP_CACHE_PATH; else process.env.MAIL_MCP_CACHE_PATH = value;
    expect(cachePath()).toBe(join(temp.home, ".mail-mcp", "token-cache.json"));
  });

  it("uses an absolute path as given, trimmed", () => {
    const own = join(temp.home, "elsewhere", "cache.json");
    process.env.MAIL_MCP_CACHE_PATH = `  ${own}  `;
    expect(cachePath()).toBe(own);
  });

  it.each(["token-cache.json", "./cache/token-cache.json", "~/.mail-mcp/token-cache.json"])(
    "refuses the relative path %j with an error that names the variable",
    (value) => {
      process.env.MAIL_MCP_CACHE_PATH = value;
      expect(() => cachePath()).toThrow(AuthError);
      expect(() => cachePath()).toThrow(/^MAIL_MCP_CACHE_PATH is not an absolute path\./);
    },
  );

  it("a relative path reaches the tools as that error, not as a missing sign-in", async () => {
    process.env.MAIL_MCP_CACHE_PATH = "token-cache.json";
    resetClient();
    await expect(getAccessToken()).rejects.toThrow(/^MAIL_MCP_CACHE_PATH is not an absolute path\./);
  });
});

// A token cache as MSAL serialises it, for one personal account. The secrets are placeholders.
const MSA_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const UID = "00000000-0000-0000-1111-222222222222";
const HOME = `${UID}.${MSA_TENANT}`;
const ENV = "login.windows.net";
const BUILT_IN = "599bb072-c4e2-42b1-b4e5-1d901fc08c66";
const OTHER_CLIENT = "11111111-2222-3333-4444-555555555555";

type SerializedCache = Record<"Account" | "IdToken" | "AccessToken" | "RefreshToken" | "AppMetadata", Record<string, object>>;

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** An unsigned ID token, as MSAL caches and parses it (it does not check signatures). */
function idTokenFor(client: string, uid = UID, username = "a@outlook.com"): string {
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "none", typ: "JWT" })}.${b64({
    ver: "2.0", iss: `https://login.microsoftonline.com/${MSA_TENANT}/v2.0`, aud: client, tid: MSA_TENANT,
    oid: uid, sub: "placeholder-subject", preferred_username: username, name: "A", iat: now, exp: now + 3600,
  })}.`;
}

function cacheObject(client: string, uid = UID, username = "a@outlook.com"): SerializedCache {
  const home = `${uid}.${MSA_TENANT}`;
  const now = Math.floor(Date.now() / 1000);
  const target = "mail.readwrite openid profile";
  const idToken = idTokenFor(client, uid, username);
  return {
    Account: {
      [`${home}-${ENV}-${MSA_TENANT}`]: {
        home_account_id: home, environment: ENV, realm: MSA_TENANT, local_account_id: uid,
        username, authority_type: "MSSTS", name: "A",
      },
    },
    IdToken: {
      [`${home}-${ENV}-idtoken-${client}-${MSA_TENANT}--`]: {
        home_account_id: home, environment: ENV, credential_type: "IdToken", client_id: client,
        secret: idToken, realm: MSA_TENANT,
      },
    },
    AccessToken: {
      [`${home}-${ENV}-accesstoken-${client}-${MSA_TENANT}-${target}-`]: {
        home_account_id: home, environment: ENV, credential_type: "AccessToken", client_id: client,
        secret: "placeholder-access-token", realm: MSA_TENANT, target, token_type: "Bearer",
        cached_at: String(now), expires_on: String(now + 3600), extended_expires_on: String(now + 7200),
      },
    },
    RefreshToken: {
      [`${home}-${ENV}-refreshtoken-${client}---`]: {
        home_account_id: home, environment: ENV, credential_type: "RefreshToken", client_id: client,
        secret: "placeholder-refresh-token",
      },
    },
    AppMetadata: {},
  };
}

function cacheFor(client: string): string {
  return JSON.stringify(cacheObject(client));
}

/** Two accounts, in this order: one signed in under another client ID (MSAL lists it with username ""), then one signed in under this one. */
function staleThenSignedIn(): string {
  const stale = cacheObject(OTHER_CLIENT, "00000000-0000-0000-3333-444444444444", "b@outlook.com");
  const current = cacheObject(BUILT_IN);
  const keys = Object.keys(current) as (keyof SerializedCache)[];
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, { ...stale[k], ...current[k] }])));
}

const TWO_MINUTES_AGO = () => new Date(Date.now() - 120_000);
const LEFTOVER_FOLDER = "token-cache.json.aaaaaaaaaaaaaaaa.tmp";

/** Temporary files a crash of the cache writer can leave next to token-cache.json, and look-alikes that are not its own. */
const leftovers = {
  STALE: "token-cache.json.0123456789abcdef.tmp",
  FRESH: "token-cache.json.fedcba9876543210.tmp",
  LINK: "token-cache.json.bbbbbbbbbbbbbbbb.tmp",
  /** Other names, upper-case hex, a wrong length, a suffix, another prefix, and a folder named like a temporary file. */
  NOT_OURS: [
    "token-cache.json.bak",
    "token-cache.json.ABCDEF0123456789.tmp",
    "token-cache.json.0123456789abcde.tmp",
    "token-cache.json.0123456789abcdef.tmp.old",
    "other.json.0123456789abcdef.tmp",
    "xtoken-cache.json.0123456789abcdef.tmp",
    LEFTOVER_FOLDER,
  ],
  /** Plants STALE, FRESH and NOT_OURS, each holding a placeholder token; all two minutes old except FRESH. */
  plant(dir: string): void {
    for (const name of [leftovers.STALE, leftovers.FRESH, ...leftovers.NOT_OURS]) {
      const file = join(dir, name);
      if (name === LEFTOVER_FOLDER) mkdirSync(file);
      else writeFileSync(file, "placeholder-refresh-token");
      if (name !== leftovers.FRESH) utimesSync(file, TWO_MINUTES_AGO(), TWO_MINUTES_AGO());
    }
  },
  /** A two-minute-old symlink named like a temporary file, pointing at a file that must not be touched. Returns that file. */
  plantLink(dir: string): string {
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "keep me");
    symlinkSync(victim, join(dir, leftovers.LINK));
    lutimesSync(join(dir, leftovers.LINK), TWO_MINUTES_AGO(), TWO_MINUTES_AGO());
    return victim;
  },
};

describe("with a token cache file", () => {
  let dir: string;
  let path: string;
  let networkCalls: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mail-mcp-auth-"));
    path = join(dir, "token-cache.json");
    process.env.MAIL_MCP_CACHE_PATH = path;
    delete process.env.MAIL_MCP_CLIENT_ID;
    resetClient();
    // MSAL 7 talks to Microsoft through the global fetch: refuse it, so these tests can never leave the machine.
    networkCalls = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      networkCalls.push(String(url));
      throw new Error("network disabled in tests");
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    expect(networkCalls).toEqual([]);
  });

  describe("signedInAccount", () => {
    it("returns the username when a token for this client ID is cached", async () => {
      writeFileSync(path, cacheFor(BUILT_IN));
      expect(await signedInAccount()).toBe("a@outlook.com");
    });

    it("a cache written for another client ID does not count as signed in", async () => {
      writeFileSync(path, cacheFor(OTHER_CLIENT));
      expect(await signedInAccount()).toBeUndefined();
    });

    it("no cache file: undefined", async () => {
      expect(await signedInAccount()).toBeUndefined();
    });

    it("a corrupt cache file: undefined, never a throw", async () => {
      writeFileSync(path, '{"AccessToken":{"k":{"secret":placeholder-secret');
      expect(await signedInAccount()).toBeUndefined();
    });
  });

  describe("an account from another client ID listed before the signed-in one", () => {
    it("the tools use the same account mail_login reports", async () => {
      writeFileSync(path, staleThenSignedIn());
      const listed = await getClient().getTokenCache().getAllAccounts();
      expect(listed.map((a) => a.username)).toEqual(["", "a@outlook.com"]); // the order this test is about
      expect(await signedInAccount()).toBe("a@outlook.com");
      expect(await getAccessToken()).toBe("placeholder-access-token");
    });
  });

  describe("getAccessToken", () => {
    it("no account: tells the assistant to call mail_login", async () => {
      await expect(getAccessToken()).rejects.toThrow(/^Not signed in\. Call the mail_login tool to sign the user in\.$/);
    });

    it("unusable sign-in: tells the assistant to sign in again", async () => {
      writeFileSync(path, cacheFor(OTHER_CLIENT));
      await expect(getAccessToken()).rejects.toThrow(
        /^The sign-in has expired\. Call the mail_login tool to sign the user in again\.$/,
      );
    });

    it("never echoes the content of a corrupt cache file (JSON.parse quotes it)", async () => {
      writeFileSync(path, '{"secret":tok123}');
      const err = await getAccessToken().then(() => undefined, (e: unknown) => e as Error);
      expect(err?.message).not.toContain("tok123");
      expect(err?.message).toBe("Not signed in. Call the mail_login tool to sign the user in.");
    });

    it("a cache folder refusal during the silent sign-in is shown as it is, not as an expired sign-in", async () => {
      writeFileSync(path, cacheFor(BUILT_IN));
      const refusal = new AuthError("The sign-in was not saved: other users can write to the folder /x. Make it private.");
      vi.spyOn(getClient(), "acquireTokenSilent").mockRejectedValue(refusal);
      await expect(getAccessToken()).rejects.toBe(refusal);
    });

    it("any other silent sign-in failure still reads as an expired sign-in", async () => {
      writeFileSync(path, cacheFor(BUILT_IN));
      vi.spyOn(getClient(), "acquireTokenSilent").mockRejectedValue(new Error("invalid_grant: placeholder-detail"));
      await expect(getAccessToken()).rejects.toThrow(
        /^The sign-in has expired\. Call the mail_login tool to sign the user in again\.$/,
      );
    });
  });

  describe("FileCachePlugin", () => {
    it("a write after a corrupt read replaces the file with valid JSON and never echoes the corrupt text", async () => {
      // The sequence of a sign-in whose cache file was corrupted (say, half-written by another process):
      // a read of the bad file, then the write that saves the new tokens.
      const plugin = new FileCachePlugin(path);
      const tokenCache = getClient().getTokenCache();
      writeFileSync(path, cacheFor(BUILT_IN));
      await plugin.beforeCacheAccess(new TokenCacheContext(tokenCache, false)); // what this process already holds
      writeFileSync(path, '{"secret":tok123');

      const access = new TokenCacheContext(tokenCache, true);
      let thrown: unknown;
      try {
        await plugin.beforeCacheAccess(access);
        await plugin.afterCacheAccess(access);
      } catch (err) {
        thrown = err;
      }
      expect(String(thrown instanceof Error ? thrown.message : thrown)).not.toContain("tok123");
      expect(thrown).toBeUndefined();

      const written = readFileSync(path, "utf8");
      expect(written).not.toContain("tok123");
      expect(() => JSON.parse(written)).not.toThrow();
      // The file is usable again: a fresh client finds the account this process held.
      resetClient();
      expect(await signedInAccount()).toBe("a@outlook.com");
    });
  });

  describe("FileCachePlugin and a cache file that disappears", () => {
    it("a deleted file empties this process's cache, and the next write does not bring the old account back", async () => {
      // `mail-mcp logout` in another process deletes the file while this server is running.
      const plugin = new FileCachePlugin(path);
      const tokenCache = getClient().getTokenCache();
      writeFileSync(path, cacheFor(BUILT_IN));
      await plugin.beforeCacheAccess(new TokenCacheContext(tokenCache, false));
      expect(Object.keys(tokenCache.getKVStore()).length).toBeGreaterThan(0);

      rmSync(path);
      const access = new TokenCacheContext(tokenCache, true);
      await plugin.beforeCacheAccess(access);
      expect(Object.keys(tokenCache.getKVStore())).toEqual([]);
      await plugin.afterCacheAccess(access);

      expect(readFileSync(path, "utf8")).not.toContain("a@outlook.com");
      resetClient();
      expect(await signedInAccount()).toBeUndefined();
    });

    it("no file yet (first sign-in): tokens added after the read are still saved", async () => {
      const plugin = new FileCachePlugin(path);
      const tokenCache = getClient().getTokenCache();
      const access = new TokenCacheContext(tokenCache, true);
      await plugin.beforeCacheAccess(access); // missing file
      tokenCache.deserialize(cacheFor(BUILT_IN)); // what MSAL does when the sign-in returns tokens
      await plugin.afterCacheAccess(access);

      resetClient();
      expect(await signedInAccount()).toBe("a@outlook.com");
    });

    it("a read during a first sign-in's write finds no file yet, and the new tokens are still saved", async () => {
      // mail_login polls (or another tool runs) while the sign-in that just returned is writing the file.
      const plugin = new FileCachePlugin(path);
      const tokenCache = getClient().getTokenCache();
      const write = new TokenCacheContext(tokenCache, true);
      await plugin.beforeCacheAccess(write); // no file: nobody has signed in yet
      tokenCache.deserialize(cacheFor(BUILT_IN)); // the tokens the sign-in returned, in memory

      // Hold the write at its mkdir, before it serializes the cache, and run the read there.
      const { mkdir: realMkdir } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let reached!: () => void;
      const writing = new Promise<void>((resolve) => { reached = resolve; });
      vi.mocked(mkdir).mockImplementationOnce((async (...args: Parameters<typeof realMkdir>) => {
        reached();
        await held;
        return realMkdir(...args);
      }) as typeof mkdir);
      const after = plugin.afterCacheAccess(write);
      await writing;
      await plugin.beforeCacheAccess(new TokenCacheContext(tokenCache, false));
      expect(existsSync(path)).toBe(false); // the read really did find no file
      release();
      await after;

      expect(readFileSync(path, "utf8")).toContain("a@outlook.com");
      resetClient();
      expect(await signedInAccount()).toBe("a@outlook.com");
    });
  });

  describe("FileCachePlugin writes", () => {
    /** Saves a signed-in cache through the plugin, as MSAL does after a sign-in or a token refresh. */
    async function save(target = path): Promise<void> {
      const tokenCache = getClient().getTokenCache();
      tokenCache.deserialize(cacheFor(BUILT_IN));
      await new FileCachePlugin(target).afterCacheAccess(new TokenCacheContext(tokenCache, true));
    }

    it("writes a new 0600 file next to the cache, opened with wx, then renames it over the cache", async () => {
      vi.mocked(writeFile).mockClear();
      vi.mocked(rename).mockClear();
      await save();
      expect(vi.mocked(writeFile).mock.calls).toHaveLength(1);
      const [temp, , options] = vi.mocked(writeFile).mock.calls[0]!;
      expect(dirname(String(temp))).toBe(dir);
      expect(String(temp)).not.toBe(path);
      expect(options).toMatchObject({ flag: "wx", mode: 0o600 });
      expect(vi.mocked(rename).mock.calls).toEqual([[temp, path]]);
      expect(readdirSync(dir)).toEqual(["token-cache.json"]);
      resetClient();
      expect(await signedInAccount()).toBe("a@outlook.com");
    });

    it("a failed rename leaves no temporary file behind", async () => {
      vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" }));
      await expect(save()).rejects.toThrow(/EXDEV/);
      expect(readdirSync(dir)).toEqual([]);
    });

    it.runIf(!POSIX)("retries a rename that Windows refuses while another program holds the file", async () => {
      const busy = () => Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
      writeFileSync(path, "{}");
      vi.mocked(rename).mockClear();
      vi.mocked(rename).mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy());
      await save();
      expect(vi.mocked(rename).mock.calls).toHaveLength(3);
      expect(readFileSync(path, "utf8")).toContain("a@outlook.com");
      expect(readdirSync(dir)).toEqual(["token-cache.json"]);
    });

    it.skipIf(!POSIX)("replaces a symlink at the cache path instead of writing through it", async () => {
      const victim = join(dir, "victim.txt");
      writeFileSync(victim, "keep me");
      symlinkSync(victim, path);
      await save();
      expect(lstatSync(path).isSymbolicLink()).toBe(false);
      expect(readFileSync(victim, "utf8")).toBe("keep me");
      expect(readFileSync(path, "utf8")).toContain("a@outlook.com");
    });

    it.skipIf(!POSIX)("a cache file left readable by others (0644) is 0600 after the next save", async () => {
      writeFileSync(path, cacheFor(BUILT_IN), { mode: 0o644 });
      chmodSync(path, 0o644);
      await save();
      expect(mode(path)).toBe(0o600);
    });

    it.skipIf(!POSIX)("creates a missing folder private (0700)", async () => {
      const nested = join(dir, "new", "token-cache.json");
      await save(nested);
      expect(mode(dirname(nested))).toBe(0o700);
      expect(mode(nested)).toBe(0o600);
    });

    it.skipIf(!POSIX).each([0o777, 0o770, 0o722])(
      "refuses a folder with mode %o, which other users can write to, naming it and quoting no token",
      async (dirMode) => {
        chmodSync(dir, dirMode);
        const err = await save().then(() => undefined, (e: unknown) => e as Error);
        expect(err).toBeInstanceOf(AuthError);
        expect(err?.message).toContain(dir);
        expect(err?.message).toMatch(/other users can write to/);
        expect(err?.message).not.toMatch(/placeholder|secret/);
        expect(readdirSync(dir)).toEqual([]);
        chmodSync(dir, 0o700);
      },
    );

    it.skipIf(!POSIX)("leaves the mode of a folder the user chose alone when others cannot write to it", async () => {
      chmodSync(dir, 0o755);
      await save();
      expect(mode(dir)).toBe(0o755);
      expect(readFileSync(path, "utf8")).toContain("a@outlook.com");
    });

    it("removes temporary cache files a crash left behind, and leaves everything else", async () => {
      leftovers.plant(dir);
      await save();
      // FRESH may be a save in progress in another Mail-MCP process: only a stale one is removed here.
      expect(readdirSync(dir).sort()).toEqual([leftovers.FRESH, ...leftovers.NOT_OURS, "token-cache.json"].sort());
    });

    it.skipIf(!POSIX)("leaves a symlink named like a temporary file alone, and its target too", async () => {
      const victim = leftovers.plantLink(dir);
      await save();
      expect(lstatSync(join(dir, leftovers.LINK)).isSymbolicLink()).toBe(true);
      expect(readFileSync(victim, "utf8")).toBe("keep me");
    });

    it.skipIf(!POSIX || process.getuid?.() === 0)("refuses a folder that belongs to another user", async () => {
      // /usr belongs to root. The check refuses before anything is written; without it, the write fails anyway.
      const err = await save("/usr/mail-mcp-test-token-cache.json").then(() => undefined, (e: unknown) => e as Error);
      expect(err).toBeInstanceOf(AuthError);
      expect(err?.message).toMatch(/belongs to another user/);
      expect(err?.message).not.toMatch(/placeholder|secret/);
    });
  });

  describe("logout", () => {
    it("removes the account and deletes the cache file", async () => {
      writeFileSync(path, cacheFor(BUILT_IN));
      expect(await logout()).toEqual({ account: "a@outlook.com" });
      expect(existsSync(path)).toBe(false);
      expect(await signedInAccount()).toBeUndefined();
    });

    it("no cache file: resolves to {}", async () => {
      expect(await logout()).toEqual({});
      expect(existsSync(path)).toBe(false);
    });

    it("a cache from another client ID is deleted, and never reported as an empty account name", async () => {
      writeFileSync(path, cacheFor(OTHER_CLIENT));
      expect(await logout()).toEqual({});
      expect(existsSync(path)).toBe(false);
    });

    it("a corrupt cache file is deleted too", async () => {
      writeFileSync(path, "not json");
      expect(await logout()).toEqual({});
      expect(existsSync(path)).toBe(false);
    });

    it("leaves no temporary cache file behind, stale or fresh, and nothing else is touched", async () => {
      writeFileSync(path, cacheFor(BUILT_IN));
      leftovers.plant(dir);
      expect(await logout()).toEqual({ account: "a@outlook.com" });
      expect(readdirSync(dir).sort()).toEqual([...leftovers.NOT_OURS].sort());
    });

    it("removes leftover temporary files even when there is no cache file", async () => {
      leftovers.plant(dir);
      expect(await logout()).toEqual({});
      expect(readdirSync(dir).sort()).toEqual([...leftovers.NOT_OURS].sort());
    });

    /** Runs `body` while unlink() fails with `code` on the STALE leftover, and works as usual on anything else. */
    async function withStaleUnlinkFailing(code: string, body: () => Promise<void>): Promise<void> {
      const real = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).unlink;
      vi.mocked(unlink).mockImplementation(async (file) => {
        if (String(file).endsWith(leftovers.STALE)) throw Object.assign(new Error(`${code}: cannot unlink`), { code });
        return real(file);
      });
      try {
        await body();
      } finally {
        vi.mocked(unlink).mockImplementation(real);
      }
    }

    it("says which leftover temporary file it could not delete", async () => {
      writeFileSync(path, cacheFor(BUILT_IN));
      leftovers.plant(dir);
      await withStaleUnlinkFailing("EBUSY", async () => {
        expect(await logout()).toEqual({ account: "a@outlook.com", notRemoved: [join(dir, leftovers.STALE)] });
      });
      expect(existsSync(path)).toBe(false);
      expect(readdirSync(dir).sort()).toEqual([leftovers.STALE, ...leftovers.NOT_OURS].sort());
    });

    it("does not report a leftover that is already gone", async () => {
      leftovers.plant(dir);
      await withStaleUnlinkFailing("ENOENT", async () => {
        expect(await logout()).toEqual({});
      });
    });

    it.skipIf(!POSIX)("leaves a symlink named like a temporary file alone, and its target too", async () => {
      writeFileSync(path, cacheFor(BUILT_IN));
      const victim = leftovers.plantLink(dir);
      await logout();
      expect(lstatSync(join(dir, leftovers.LINK)).isSymbolicLink()).toBe(true);
      expect(readFileSync(victim, "utf8")).toBe("keep me");
    });
  });
});

/** A cache whose access token has expired, so that a silent sign-in refreshes it with the refresh token. */
function expiredCacheFor(client: string): string {
  const cache = cacheObject(client);
  const past = String(Math.floor(Date.now() / 1000) - 600);
  for (const entry of Object.values(cache.AccessToken)) Object.assign(entry, { expires_on: past, extended_expires_on: past });
  return JSON.stringify(cache);
}

/** Microsoft's sign-in endpoints, faked: authority discovery and a token endpoint that grants a refresh. Nothing leaves the machine. */
function fakeMicrosoft(calls: string[]) {
  const base = "https://login.microsoftonline.com/consumers";
  const json = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  return async (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    if (url.includes("/discovery/instance")) {
      return json({
        tenant_discovery_endpoint: `${base}/v2.0/.well-known/openid-configuration`,
        metadata: [{ preferred_network: "login.microsoftonline.com", preferred_cache: "login.windows.net", aliases: ["login.microsoftonline.com", "login.windows.net"] }],
      });
    }
    if (url.includes("/.well-known/openid-configuration")) {
      return json({
        authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
        token_endpoint: `${base}/oauth2/v2.0/token`,
        end_session_endpoint: `${base}/oauth2/v2.0/logout`,
        issuer: `https://login.microsoftonline.com/${MSA_TENANT}/v2.0`,
        jwks_uri: `${base}/discovery/v2.0/keys`,
      });
    }
    if (url.includes("/oauth2/v2.0/token")) {
      return json({
        token_type: "Bearer", scope: "Mail.ReadWrite openid profile", expires_in: 3600, ext_expires_in: 3600,
        access_token: "placeholder-new-access-token", refresh_token: "placeholder-new-refresh-token",
        id_token: idTokenFor(BUILT_IN), client_info: b64({ uid: UID, utid: MSA_TENANT }),
      });
    }
    throw new Error(`unexpected network call in test: ${url}`);
  };
}

describe("a silent token refresh whose save is refused", () => {
  let dir: string;
  let calls: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mail-mcp-refresh-"));
    const path = join(dir, "token-cache.json");
    process.env.MAIL_MCP_CACHE_PATH = path;
    delete process.env.MAIL_MCP_CLIENT_ID;
    writeFileSync(path, expiredCacheFor(BUILT_IN));
    resetClient();
    calls = [];
    vi.stubGlobal("fetch", fakeMicrosoft(calls));
  });

  afterEach(() => {
    if (POSIX) chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
    expect(calls.every((u) => u.startsWith("https://login.microsoftonline.com/"))).toBe(true);
  });

  it("refreshes, offline, when the save works (the fixture is sound)", async () => {
    expect(await getAccessToken()).toBe("placeholder-new-access-token");
    expect(calls.some((u) => u.includes("/oauth2/v2.0/token"))).toBe(true);
  });

  it("MSAL passes the save's own error on, and getAccessToken shows it unchanged", async () => {
    const refusal = new AuthError("The sign-in was not saved: a placeholder reason.");
    vi.mocked(rename).mockRejectedValueOnce(refusal);
    await expect(getAccessToken()).rejects.toBe(refusal);
  });

  it.skipIf(!POSIX)("a cache folder other users can write to is reported as such, at once", async () => {
    chmodSync(dir, 0o777);
    await expect(getAccessToken()).rejects.toThrow(/^The sign-in was not saved: other users can write to the folder /);
  });
});

describe("a sign-in saved by 0.2.x at the default path", () => {
  const temp = useTempHome();
  let dir: string;
  let path: string;
  let networkCalls: string[];

  beforeEach(() => {
    // What 0.2.x leaves: ~/.mail-mcp created 0700, token-cache.json written 0600.
    dir = join(temp.home, ".mail-mcp");
    path = join(dir, "token-cache.json");
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(path, cacheFor(BUILT_IN), { mode: 0o600 });
    delete process.env.MAIL_MCP_CACHE_PATH;
    delete process.env.MAIL_MCP_CLIENT_ID;
    resetClient();
    networkCalls = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      networkCalls.push(String(url));
      throw new Error("network disabled in tests");
    });
  });

  afterEach(() => {
    expect(networkCalls).toEqual([]);
  });

  it("keeps the user signed in after the upgrade, with no new sign-in", async () => {
    expect(cachePath()).toBe(path);
    expect(await signedInAccount()).toBe("a@outlook.com");
    expect(await getAccessToken()).toBe("placeholder-access-token");
  });

  it.each(["", "   ", "${user_config.cache_path}"])("also when MAIL_MCP_CACHE_PATH is %j", async (value) => {
    process.env.MAIL_MCP_CACHE_PATH = value;
    expect(await signedInAccount()).toBe("a@outlook.com");
  });

  it("still works after the cache is saved again, and nothing else is left in the folder", async () => {
    const tokenCache = getClient().getTokenCache();
    const plugin = new FileCachePlugin(cachePath());
    const access = new TokenCacheContext(tokenCache, true);
    await plugin.beforeCacheAccess(access);
    await plugin.afterCacheAccess(access);
    expect(readdirSync(dir)).toEqual(["token-cache.json"]);
    if (POSIX) {
      expect(mode(dir)).toBe(0o700);
      expect(mode(path)).toBe(0o600);
    }
    resetClient();
    expect(await signedInAccount()).toBe("a@outlook.com");
  });

  it.skipIf(!POSIX)("an existing ~/.mail-mcp that others can read or write is made private (0700) on the next save", async () => {
    chmodSync(dir, 0o777);
    const tokenCache = getClient().getTokenCache();
    const plugin = new FileCachePlugin(cachePath());
    const access = new TokenCacheContext(tokenCache, true);
    await plugin.beforeCacheAccess(access);
    await plugin.afterCacheAccess(access);
    expect(mode(dir)).toBe(0o700);
    resetClient();
    expect(await signedInAccount()).toBe("a@outlook.com");
  });
});

describe("loginInteractive", () => {
  it("asks Microsoft for the account picker and serves plain-text result pages", async () => {
    process.env.MAIL_MCP_CACHE_PATH = join(tmpdir(), "mail-mcp-test-never-written.json");
    resetClient();
    const spy = vi.spyOn(getClient(), "acquireTokenInteractive").mockResolvedValue({
      account: { username: "a@outlook.com" },
    } as Awaited<ReturnType<ReturnType<typeof getClient>["acquireTokenInteractive"]>>);
    const open = async () => {};
    expect((await loginInteractive(open)).username).toBe("a@outlook.com");
    expect(spy).toHaveBeenCalledWith({
      scopes: ["Mail.ReadWrite"],
      prompt: "select_account",
      openBrowser: open,
      successTemplate: "Mail-MCP is connected. You can close this tab.",
      errorTemplate: "Mail-MCP sign-in failed. Go back to Claude and try again.",
    });
  });
});
