import { PublicClientApplication, type INetworkModule, type NetworkResponse } from "@azure/msal-node";
import { describe, expect, it } from "vitest";
import { AUTHORITY, DEFAULT_CLIENT_ID, SCOPES } from "../src/constants.js";
import { LoginFlow, cancelLoopback, type LoginDeps } from "../src/session.js";

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
      if (o.openBrowser) await o.openBrowser(url);
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

describe("cancelLoopback", () => {
  it("posts an OAuth error to the loopback redirect URI", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    await cancelLoopback(URL_A, (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response(""); }) as unknown as typeof fetch);
    // MSAL listens on 127.0.0.1 only; "localhost" may resolve to ::1.
    expect(seen[0]!.url).toBe("http://127.0.0.1:50123/");
    expect(seen[0]!.init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(String(seen[0]!.init.body)).toContain("error=login_timeout");
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
    expect(redirect.hostname).toBe("localhost");

    await cancelLoopback(url);

    expect(await Promise.race([outcome, sleep(2000).then(() => "still waiting after 2 s")])).toContain("login_timeout");
    // The loopback server is closed: its port no longer answers. (Windows can take ~2 s to refuse, hence the abort.)
    await expect(fetch(`http://127.0.0.1:${redirect.port}/`, { signal: AbortSignal.timeout(1500) })).rejects.toThrow();
    expect(network.urls.filter((u) => !u.includes("openid-configuration") && !u.includes("discovery/instance"))).toEqual([]);
  }, 5000);
});
