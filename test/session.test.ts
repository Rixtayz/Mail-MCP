import { PublicClientApplication, type INetworkModule, type NetworkResponse } from "@azure/msal-node";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTHORITY, DEFAULT_CLIENT_ID, SCOPES } from "../src/constants.js";
import { openSignInPage, writeSignInPage } from "../src/login.js";
import { LoginFlow, cancelLoopback, type LoginDeps } from "../src/session.js";
import { sessionService } from "../src/tools/session.js";

const URL_A =
  "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A50123";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Login = LoginDeps["loginInteractive"];
type Fakes = LoginDeps & { opened: string[]; cancelled: string[]; loginCalls: number };

/** A LoginDeps made of recording fakes; `login` becomes loginInteractive. */
function deps(
  o: {
    signedInAccount?: LoginDeps["signedInAccount"];
    login?: Login;
    openBrowser?: LoginDeps["openBrowser"];
    cancel?: LoginDeps["cancel"];
  } = {},
): Fakes {
  const d: Fakes = {
    opened: [],
    cancelled: [],
    loginCalls: 0,
    waitMs: 30,
    giveUpMs: 80,
    signedInAccount: o.signedInAccount ?? (async () => undefined),
    loginInteractive: (open) => {
      d.loginCalls++;
      return (o.login ?? (() => new Promise<never>(() => {})))(open);
    },
    openBrowser: async (url) => {
      d.opened.push(url);
      return o.openBrowser ? o.openBrowser(url) : undefined;
    },
    cancel: async (url) => {
      d.cancelled.push(url);
      if (o.cancel) await o.cancel(url);
    },
  };
  return d;
}

describe("LoginFlow", () => {
  it("already signed in: no browser", async () => {
    const d = deps({ signedInAccount: async () => "a@outlook.com" });
    expect(await new LoginFlow(d).start()).toEqual({ status: "signed_in", account: "a@outlook.com" });
    expect(d.opened).toEqual([]);
  });

  it("completes within the wait", async () => {
    const d = deps({ login: async (open) => { await open(URL_A); return { username: "a@outlook.com" }; } });
    expect(await new LoginFlow(d).start()).toEqual({ status: "signed_in", account: "a@outlook.com" });
    expect(d.opened).toEqual([URL_A]);
  });

  it("pending, then a second call reuses the same sign-in and opens no second window", async () => {
    const gate = deferred<{ username: string }>();
    let done = false;
    const d = deps({
      signedInAccount: async () => (done ? "a@outlook.com" : undefined),
      login: async (open) => { await open(URL_A); return gate.promise; },
    });
    const flow = new LoginFlow(d);
    expect(await flow.start()).toEqual({ status: "pending", url: URL_A });
    expect(await flow.start()).toEqual({ status: "pending", url: URL_A });
    done = true;
    gate.resolve({ username: "a@outlook.com" });
    expect(await flow.start()).toEqual({ status: "signed_in", account: "a@outlook.com" });
    expect(d.opened).toEqual([URL_A]);
    expect(d.loginCalls).toBe(1);
  });

  it("two calls at the same moment share one sign-in", async () => {
    const d = deps({ login: async (open) => { await open(URL_A); return new Promise<never>(() => {}); } });
    const flow = new LoginFlow(d);
    const results = await Promise.all([flow.start(), flow.start()]);
    expect(results).toEqual([{ status: "pending", url: URL_A }, { status: "pending", url: URL_A }]);
    expect(d.loginCalls).toBe(1);
    expect(d.opened).toEqual([URL_A]);
  });

  it("a failure that happens between two calls is reported once, then the next call starts fresh", async () => {
    const gate = deferred<{ username: string }>();
    const d = deps({ login: async (open) => { await open(URL_A); return gate.promise; } });
    const flow = new LoginFlow(d);
    await flow.start();
    gate.reject(new Error("access_denied: The user has denied access."));
    await sleep(5);
    expect(await flow.start()).toEqual({ status: "failed", detail: "access_denied: The user has denied access." });
    expect(d.loginCalls).toBe(1);
    await flow.start();
    expect(d.loginCalls).toBe(2);
  });

  it("still returns the URL when the browser cannot be opened", async () => {
    const d = deps({
      login: async (open) => { await open(URL_A); return new Promise(() => {}); },
      openBrowser: async () => { throw new Error("no display"); },
    });
    expect(await new LoginFlow(d).start()).toEqual({ status: "pending", url: URL_A });
  });

  it("keeps waiting past waitMs until the sign-in URL is known, so pending always carries one", async () => {
    const d = deps({ login: async (open) => { await sleep(60); await open(URL_A); return new Promise(() => {}); } });
    expect(await new LoginFlow(d).start()).toEqual({ status: "pending", url: URL_A });
  });

  it("declined consent fails at once with the first line of the reason", async () => {
    const d = deps({
      login: async (open) => { await open(URL_A); throw new Error("access_denied: The user has denied access.\nTrace ID: 123"); },
    });
    expect(await new LoginFlow(d).start()).toEqual({ status: "failed", detail: "access_denied: The user has denied access." });
  });

  it("cuts a Windows line ending from the reason too", async () => {
    const d = deps({ login: async () => { throw new Error("AADSTS65004: User declined to consent.\r\nTrace ID: 1"); } });
    expect(await new LoginFlow(d).start()).toEqual({ status: "failed", detail: "AADSTS65004: User declined to consent." });
  });

  it("gives up after giveUpMs, cancels the loopback, and the next call starts a fresh sign-in", async () => {
    const gate = deferred<{ username: string }>();
    const d = deps({
      login: async (open) => { await open(URL_A); return gate.promise; },
      cancel: async () => { gate.reject(new Error("login_timeout")); },
    });
    const flow = new LoginFlow(d);
    await flow.start();
    await sleep(120);
    expect(d.cancelled).toEqual([URL_A]);
    await flow.start();
    expect(d.loginCalls).toBe(2);
  });

  it("the give-up is silent: the next call opens a fresh sign-in instead of reporting the cancel", async () => {
    const gates = [deferred<{ username: string }>(), deferred<{ username: string }>()];
    const d = deps({
      login: async (open) => { await open(URL_A); return gates[d.loginCalls - 1]!.promise; },
      cancel: async () => { gates[0]!.reject(new Error("login_timeout: Sign-in was not completed in time")); },
    });
    const flow = new LoginFlow(d);
    await flow.start();
    await sleep(120);
    expect(await flow.start()).toEqual({ status: "pending", url: URL_A });
    expect(d.opened).toEqual([URL_A, URL_A]);
  });

  it("a call that is waiting when the give-up fires answers failed, not a dead URL", async () => {
    const gate = deferred<{ username: string }>();
    const d = deps({
      login: async (open) => { await open(URL_A); return gate.promise; },
      cancel: async () => { gate.reject(new Error("login_timeout: Sign-in was not completed in time")); },
    });
    d.waitMs = 50; // second call waits 50..100 ms; the give-up fires at 80 ms
    const flow = new LoginFlow(d);
    expect(await flow.start()).toEqual({ status: "pending", url: URL_A });
    expect(await flow.start()).toEqual({ status: "failed", detail: "login_timeout: Sign-in was not completed in time" });
    expect(d.opened).toEqual([URL_A]);
  });

  it("a give-up whose cancel fails still lets the next call start fresh", async () => {
    const d = deps({
      login: async (open) => { await open(URL_A); return new Promise(() => {}); },
      cancel: async () => { throw new Error("ECONNREFUSED"); },
    });
    const flow = new LoginFlow(d);
    await flow.start();
    await sleep(120);
    expect(await flow.start()).toEqual({ status: "pending", url: URL_A });
    expect(d.loginCalls).toBe(2);
  });

  it("a stale cache from another client ID does not count as signed in", async () => {
    const d = deps({
      signedInAccount: async () => undefined,
      login: async (open) => { await open(URL_A); return { username: "a@outlook.com" }; },
    });
    await new LoginFlow(d).start();
    expect(d.loginCalls).toBe(1);
  });
});

describe("LoginFlow and the sign-in page the browser was opened on", () => {
  /** An openBrowser that leaves a page behind and counts how often it is removed. */
  function page() {
    const p = { removed: 0, openBrowser: async () => async () => { p.removed++; } };
    return p;
  }

  it("removes it when the sign-in succeeds", async () => {
    const p = page();
    const d = deps({ openBrowser: p.openBrowser, login: async (open) => { await open(URL_A); return { username: "a@outlook.com" }; } });
    expect(await new LoginFlow(d).start()).toEqual({ status: "signed_in", account: "a@outlook.com" });
    expect(p.removed).toBe(1);
  });

  it("removes it when the sign-in fails", async () => {
    const p = page();
    const d = deps({ openBrowser: p.openBrowser, login: async (open) => { await open(URL_A); throw new Error("access_denied"); } });
    expect((await new LoginFlow(d).start()).status).toBe("failed");
    expect(p.removed).toBe(1);
  });

  it("removes it when the sign-in is given up, even if the cancel fails", async () => {
    const p = page();
    const d = deps({
      openBrowser: p.openBrowser,
      login: async (open) => { await open(URL_A); return new Promise<never>(() => {}); },
      cancel: async () => { throw new Error("ECONNREFUSED"); },
    });
    await new LoginFlow(d).start();
    expect(p.removed).toBe(0);
    await sleep(120);
    expect(p.removed).toBe(1);
  });

  it("removes it once, however the sign-in ends", async () => {
    const p = page();
    const gate = deferred<{ username: string }>();
    const d = deps({
      openBrowser: p.openBrowser,
      login: async (open) => { await open(URL_A); return gate.promise; },
      cancel: async () => { gate.reject(new Error("login_timeout")); },
    });
    await new LoginFlow(d).start();
    await sleep(120); // given up, then ended by the cancel
    expect(p.removed).toBe(1);
  });

  it("a page that finishes opening after the sign-in was cancelled is removed at once", async () => {
    let removed = 0;
    const opening = deferred<void>();
    const d = deps({
      openBrowser: async () => { await opening.promise; return async () => { removed++; }; },
      login: async (open) => { void open(URL_A); return new Promise<never>(() => {}); },
    });
    const flow = new LoginFlow(d);
    expect(await flow.start()).toEqual({ status: "pending", url: URL_A });
    await flow.cancel();
    opening.resolve();
    await sleep(5);
    expect(removed).toBe(1);
  });
});

describe("LoginFlow.cancel", () => {
  it("ends a pending sign-in: the loopback is told to stop, and the next call starts afresh", async () => {
    const gates = [deferred<{ username: string }>(), deferred<{ username: string }>()];
    const d = deps({
      login: async (open) => { await open(URL_A); return gates[d.loginCalls - 1]!.promise; },
      cancel: async () => { gates[0]!.reject(new Error("login_timeout: Sign-in was not completed in time")); },
    });
    const flow = new LoginFlow(d);
    expect(await flow.start()).toEqual({ status: "pending", url: URL_A });
    await flow.cancel();
    expect(d.cancelled).toEqual([URL_A]);
    // The cancel is not reported as a failure: the next call opens a fresh sign-in.
    expect(await flow.start()).toEqual({ status: "pending", url: URL_A });
    expect(d.loginCalls).toBe(2);
  });

  it("resolves only once the sign-in has ended", async () => {
    const gate = deferred<{ username: string }>();
    const events: string[] = [];
    const d = deps({
      login: async (open) => { await open(URL_A); return gate.promise; },
      cancel: async () => {
        events.push("cancel posted");
        setTimeout(() => { events.push("sign-in ended"); gate.reject(new Error("login_timeout")); }, 10);
      },
    });
    const flow = new LoginFlow(d);
    await flow.start();
    await flow.cancel();
    events.push("cancel resolved");
    expect(events).toEqual(["cancel posted", "sign-in ended", "cancel resolved"]);
  });

  it("does nothing when no sign-in is in progress", async () => {
    const d = deps();
    await new LoginFlow(d).cancel();
    expect(d.cancelled).toEqual([]);
    expect(d.loginCalls).toBe(0);
  });

  it("before MSAL has built the URL: the browser never opens, and the sign-in is cancelled once the URL exists", async () => {
    const urlReady = deferred<void>();
    const gate = deferred<{ username: string }>();
    const d = deps({
      login: async (open) => { await urlReady.promise; await open(URL_A); return gate.promise; },
      cancel: async () => { gate.reject(new Error("login_timeout")); },
    });
    d.waitMs = 5;
    const flow = new LoginFlow(d);
    const waiting = flow.start(); // still waiting for the URL
    await sleep(10);
    const cancelled = flow.cancel();
    urlReady.resolve();
    await cancelled;
    expect(d.opened).toEqual([]);
    expect(d.cancelled).toEqual([URL_A]);
    expect((await waiting).status).toBe("failed");
  });

  it("an unreported failure is dropped, and nothing is posted to a loopback that is already closed", async () => {
    const gates = [deferred<{ username: string }>(), deferred<{ username: string }>()];
    const d = deps({ login: async (open) => { await open(URL_A); return gates[d.loginCalls - 1]!.promise; } });
    const flow = new LoginFlow(d);
    await flow.start();
    gates[0]!.reject(new Error("access_denied"));
    await sleep(5);
    await flow.cancel();
    expect(d.cancelled).toEqual([]);
    expect((await flow.start()).status).toBe("pending"); // a fresh sign-in, not the old failure
    expect(d.loginCalls).toBe(2);
  });
});

describe("sessionService", () => {
  it("logout cancels a pending sign-in, waits for it to end, then signs out", async () => {
    const gate = deferred<{ username: string }>();
    const events: string[] = [];
    const d = deps({
      login: async (open) => { await open(URL_A); return gate.promise; },
      cancel: async () => { events.push("cancel"); gate.reject(new Error("login_timeout")); },
    });
    const session = sessionService(new LoginFlow(d), async () => { events.push("sign out"); return { account: "a@outlook.com" }; });
    expect(await session.login()).toEqual({ status: "pending", url: URL_A });
    expect(await session.logout()).toEqual({ account: "a@outlook.com" });
    expect(events).toEqual(["cancel", "sign out"]);
    expect(d.cancelled).toEqual([URL_A]);
  });

  it("logout with no sign-in in progress just signs out", async () => {
    const d = deps();
    let signedOut = 0;
    const session = sessionService(new LoginFlow(d), async () => { signedOut++; return {}; });
    expect(await session.logout()).toEqual({});
    expect(signedOut).toBe(1);
    expect(d.cancelled).toEqual([]);
  });
});

describe("the sign-in page", () => {
  const AUTH =
    "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A50123&state=s%3D1&code_challenge=abc";

  it("holds only a meta refresh and a link to the URL, both HTML-escaped, and no script", async () => {
    const page = await writeSignInPage(AUTH);
    try {
      const html = readFileSync(page.file, "utf8");
      const escaped = AUTH.replaceAll("&", "&amp;");
      expect(html).toContain(`<meta http-equiv="refresh" content="0;url=${escaped}">`);
      expect(html).toContain(`<a href="${escaped}">`);
      expect(html.replaceAll("&amp;", "")).not.toContain("&");
      const tags = [...html.matchAll(/<\s*([a-z!][a-z0-9-]*)/gi)].map((m) => m[1]!.toLowerCase());
      expect(tags).toEqual(["!doctype", "meta", "meta", "title", "a"]);
      expect(html).not.toMatch(/<script|\son\w+\s*=|javascript:/i);
    } finally {
      await page.remove();
    }
  });

  it("characters special to HTML in the URL cannot leave the attribute", async () => {
    const page = await writeSignInPage(`https://login.microsoftonline.com/x?a="><script>alert(1)</script>&b='x'`);
    try {
      const html = readFileSync(page.file, "utf8");
      expect(html).not.toMatch(/<script/i);
      const tags = [...html.matchAll(/<\s*([a-z!][a-z0-9-]*)/gi)].map((m) => m[1]!.toLowerCase());
      expect(tags).toEqual(["!doctype", "meta", "meta", "title", "a"]);
      expect(html.match(/"/g)?.length).toBe(8); // the attribute quotes only: charset, http-equiv, content, href
    } finally {
      await page.remove();
    }
  });

  it.each(["http://login.microsoftonline.com/x", "javascript:alert(1)", "file:///etc/passwd", "not a url"])(
    "refuses %j and writes nothing",
    async (url) => {
      const before = readdirSync(tmpdir()).filter((n) => n.startsWith("mail-mcp-sign-in-"));
      await expect(writeSignInPage(url)).rejects.toThrow(/not an https address/);
      expect(readdirSync(tmpdir()).filter((n) => n.startsWith("mail-mcp-sign-in-"))).toEqual(before);
    },
  );

  it("lives in its own folder in the temporary folder, private on macOS and Linux (0700 folder, 0600 file)", async () => {
    const page = await writeSignInPage(AUTH);
    try {
      const dir = dirname(page.file);
      expect(dirname(dir)).toBe(tmpdir());
      expect(relative(tmpdir(), dir)).toMatch(/^mail-mcp-sign-in-/);
      expect(readdirSync(dir)).toEqual(["sign-in.html"]);
      if (process.platform !== "win32") {
        expect(statSync(dir).mode & 0o777).toBe(0o700);
        expect(statSync(page.file).mode & 0o777).toBe(0o600);
      }
    } finally {
      await page.remove();
    }
  });

  it("remove() deletes the folder, and a second call is harmless", async () => {
    const page = await writeSignInPage(AUTH);
    await page.remove();
    expect(existsSync(dirname(page.file))).toBe(false);
    await page.remove();
  });

  it("is deleted if the process exits before the sign-in ends", async () => {
    const before = process.listeners("exit");
    const page = await writeSignInPage(AUTH);
    const added = process.listeners("exit").filter((l) => !before.includes(l));
    expect(added).toHaveLength(1);
    (added[0] as () => void)();
    expect(existsSync(dirname(page.file))).toBe(false);
    await page.remove();
    expect(process.listeners("exit")).toEqual(before);
  });
});

describe("openSignInPage", () => {
  const AUTH = "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=x&state=abc";

  it("hands the opener the page's path, never the URL, and the returned function deletes the page", async () => {
    const targets: string[] = [];
    const remove = await openSignInPage(AUTH, async (target) => { targets.push(target); });
    expect(targets).toHaveLength(1);
    const file = targets[0]!;
    expect(file).not.toMatch(/login\.microsoftonline|state|client_id/);
    expect(file.endsWith("sign-in.html")).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("state=abc");
    await remove();
    expect(existsSync(dirname(file))).toBe(false);
  });

  it("deletes the page when the browser cannot be opened, and passes the error on", async () => {
    let file = "";
    await expect(openSignInPage(AUTH, async (target) => { file = target; throw new Error("no display"); })).rejects.toThrow("no display");
    expect(file).not.toBe("");
    expect(existsSync(dirname(file))).toBe(false);
  });
});

describe("cancelLoopback", () => {
  it("posts an OAuth error to the loopback redirect URI", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    await cancelLoopback(URL_A, (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response(""); }) as unknown as typeof fetch);
    // MSAL listens on 127.0.0.1 only; "localhost" may resolve to ::1.
    expect(seen[0]!.url).toBe("http://127.0.0.1:50123/");
    expect(seen[0]!.init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(String(seen[0]!.init.body)).toContain("error=login_timeout");
  });

  it("echoes the state of the authorization request, which MSAL requires to accept the callback", async () => {
    const seen: string[] = [];
    await cancelLoopback(`${URL_A}&state=abc%3D%3Ddef`, (async (_url: string, init: RequestInit) => { seen.push(String(init.body)); return new Response(""); }) as unknown as typeof fetch);
    expect(new URLSearchParams(seen[0]).get("state")).toBe("abc==def");
    expect(new URLSearchParams(seen[0]).get("error")).toBe("login_timeout");
  });

  it("refuses a redirect URI that is not loopback", async () => {
    let called = false;
    await cancelLoopback("https://login.microsoftonline.com/x?redirect_uri=https%3A%2F%2Fevil.example%2F", (async () => { called = true; return new Response(""); }) as unknown as typeof fetch);
    expect(called).toBe(false);
  });

  it.each([
    ["no redirect_uri", "https://login.microsoftonline.com/x?client_id=y"],
    ["not a URL", "not a url"],
    ["loopback without a port", "https://login.microsoftonline.com/x?redirect_uri=http%3A%2F%2Flocalhost"],
    ["https loopback", "https://login.microsoftonline.com/x?redirect_uri=https%3A%2F%2Flocalhost%3A50123"],
    ["a host that only starts with localhost", "https://login.microsoftonline.com/x?redirect_uri=http%3A%2F%2Flocalhost.evil.example%3A50123"],
  ])("refuses %s", async (_name, authUrl) => {
    let called = false;
    await cancelLoopback(authUrl, (async () => { called = true; return new Response(""); }) as unknown as typeof fetch);
    expect(called).toBe(false);
  });
});

describe("MSAL guard: the cancel trick still works with the installed @azure/msal-node", () => {
  /** Answers MSAL's authority discovery from canned metadata and refuses everything else, so the test never leaves the machine. */
  function offlineNetwork(): INetworkModule & { urls: string[] } {
    const urls: string[] = [];
    const answer = async <T>(url: string): Promise<NetworkResponse<T>> => {
      urls.push(url);
      const base = "https://login.microsoftonline.com/consumers";
      if (url.includes("/.well-known/openid-configuration")) {
        return {
          status: 200,
          headers: {},
          body: {
            authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
            token_endpoint: `${base}/oauth2/v2.0/token`,
            end_session_endpoint: `${base}/oauth2/v2.0/logout`,
            issuer: "https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0",
            jwks_uri: `${base}/discovery/v2.0/keys`,
          } as T,
        };
      }
      if (url.includes("/discovery/instance")) {
        return {
          status: 200,
          headers: {},
          body: {
            tenant_discovery_endpoint: `${base}/v2.0/.well-known/openid-configuration`,
            metadata: [{ preferred_network: "login.microsoftonline.com", preferred_cache: "login.windows.net", aliases: ["login.microsoftonline.com", "login.windows.net"] }],
          } as T,
        };
      }
      throw new Error(`unexpected network call in test: ${url}`);
    };
    return { urls, sendGetRequestAsync: answer, sendPostRequestAsync: answer };
  }

  it("a POSTed login_timeout makes acquireTokenInteractive reject and frees the port", async () => {
    const network = offlineNetwork();
    const pca = new PublicClientApplication({
      auth: { clientId: DEFAULT_CLIENT_ID, authority: AUTHORITY },
      system: { networkClient: network },
    });
    const authUrl = deferred<string>();
    const outcome = pca
      .acquireTokenInteractive({ scopes: SCOPES, openBrowser: async (url) => authUrl.resolve(url) })
      .then(
        () => "resolved",
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
    const url = await authUrl.promise;
    const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!);

    await cancelLoopback(url);

    expect(await Promise.race([outcome, sleep(2000).then(() => "still waiting after 2 s")])).toContain("login_timeout");
    // The loopback server is closed: its port no longer answers. (Windows can take ~2 s to refuse, hence the abort.)
    await expect(fetch(`http://127.0.0.1:${redirect.port}/`, { signal: AbortSignal.timeout(1500) })).rejects.toThrow();
    expect(network.urls.filter((u) => !u.includes("openid-configuration") && !u.includes("discovery/instance"))).toEqual([]);
  }, 5000);

  it("LoginFlow.cancel closes MSAL's loopback listener before it resolves", async () => {
    const network = offlineNetwork();
    const pca = new PublicClientApplication({
      auth: { clientId: DEFAULT_CLIENT_ID, authority: AUTHORITY },
      system: { networkClient: network },
    });
    const flow = new LoginFlow({
      signedInAccount: async () => undefined,
      loginInteractive: async (openBrowser) => {
        const result = await pca.acquireTokenInteractive({ scopes: SCOPES, openBrowser });
        return { username: result.account?.username ?? "" };
      },
      openBrowser: async () => {}, // no real browser
      cancel: (authUrl) => cancelLoopback(authUrl),
      waitMs: 1000,
      giveUpMs: 60_000,
    });
    const started = await flow.start();
    expect(started.status).toBe("pending");
    const url = (started as { url: string }).url;
    const redirect = new URL(new URL(url).searchParams.get("redirect_uri")!);

    await flow.cancel();

    // Windows can take ~2 s to refuse, hence the abort.
    await expect(fetch(`http://127.0.0.1:${redirect.port}/`, { signal: AbortSignal.timeout(1500) })).rejects.toThrow();
    expect(network.urls.filter((u) => !u.includes("openid-configuration") && !u.includes("discovery/instance"))).toEqual([]);
  }, 8000);
});
