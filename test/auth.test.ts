import { TokenCacheContext } from "@azure/msal-node";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FileCachePlugin,
  clientId,
  getAccessToken,
  getClient,
  loginInteractive,
  logout,
  resetClient,
  signedInAccount,
} from "../src/auth.js";

const ENV_KEYS = ["MAIL_MCP_CLIENT_ID", "MAIL_MCP_CACHE_PATH"] as const;
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

// A token cache as MSAL serialises it, for one personal account. The secrets are placeholders.
const MSA_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const UID = "00000000-0000-0000-1111-222222222222";
const HOME = `${UID}.${MSA_TENANT}`;
const ENV = "login.windows.net";
const BUILT_IN = "599bb072-c4e2-42b1-b4e5-1d901fc08c66";
const OTHER_CLIENT = "11111111-2222-3333-4444-555555555555";

function cacheFor(client: string): string {
  const now = Math.floor(Date.now() / 1000);
  const target = "mail.readwrite openid profile";
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const idToken = `${b64({ alg: "none", typ: "JWT" })}.${b64({
    ver: "2.0", iss: `https://login.microsoftonline.com/${MSA_TENANT}/v2.0`, aud: client, tid: MSA_TENANT,
    oid: UID, sub: "placeholder-subject", preferred_username: "a@outlook.com", name: "A", iat: now, exp: now + 3600,
  })}.`;
  return JSON.stringify({
    Account: {
      [`${HOME}-${ENV}-${MSA_TENANT}`]: {
        home_account_id: HOME, environment: ENV, realm: MSA_TENANT, local_account_id: UID,
        username: "a@outlook.com", authority_type: "MSSTS", name: "A",
      },
    },
    IdToken: {
      [`${HOME}-${ENV}-idtoken-${client}-${MSA_TENANT}--`]: {
        home_account_id: HOME, environment: ENV, credential_type: "IdToken", client_id: client,
        secret: idToken, realm: MSA_TENANT,
      },
    },
    AccessToken: {
      [`${HOME}-${ENV}-accesstoken-${client}-${MSA_TENANT}-${target}-`]: {
        home_account_id: HOME, environment: ENV, credential_type: "AccessToken", client_id: client,
        secret: "placeholder-access-token", realm: MSA_TENANT, target, token_type: "Bearer",
        cached_at: String(now), expires_on: String(now + 3600), extended_expires_on: String(now + 7200),
      },
    },
    RefreshToken: {
      [`${HOME}-${ENV}-refreshtoken-${client}---`]: {
        home_account_id: HOME, environment: ENV, credential_type: "RefreshToken", client_id: client,
        secret: "placeholder-refresh-token",
      },
    },
    AppMetadata: {},
  });
}

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
      const result = await logout();
      expect(result.account).not.toBe("");
      expect(existsSync(path)).toBe(false);
    });

    it("a corrupt cache file is deleted too", async () => {
      writeFileSync(path, "not json");
      expect(await logout()).toEqual({});
      expect(existsSync(path)).toBe(false);
    });
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
