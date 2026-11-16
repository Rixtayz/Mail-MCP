# Mail-MCP 0.2.0 Zero-Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new user reaches a working Outlook.com mailbox in Claude Desktop with one download, one double-click and one Microsoft sign-in, and the server can no longer send email at all.

**Architecture:** The server gains a built-in Entra client ID, asks for `Mail.ReadWrite` only, and exposes sign-in and sign-out as MCP tools backed by a small single-flight state machine around MSAL's interactive flow. The `mailto:` unsubscribe path stops sending and returns a link instead. Packaging adds a Claude Desktop `.mcpb` bundle and a tag-triggered release workflow that publishes to npm through trusted publishing.

**Tech Stack:** TypeScript (NodeNext, strict), Node ≥ 22, `@modelcontextprotocol/server` 2.x, `@azure/msal-node` 7, zod v4, vitest 5, `@anthropic-ai/mcpb` 2.x (new dev dependency), GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-16-zero-setup-design.md`

## Global Constraints

- Work on branch `feat/zero-setup`, cut from `main`. Never commit to `main`. Do not push or open a pull request until the owner says so.
- Built-in client ID, verbatim: `599bb072-c4e2-42b1-b4e5-1d901fc08c66`. Authority stays `https://login.microsoftonline.com/consumers`.
- The only Graph scope requested is `Mail.ReadWrite`. No code path sends an email; no request to `/me/sendMail` exists anywhere in `src/`.
- No telemetry, analytics or update ping. The server contacts only `login.microsoftonline.com`, `graph.microsoft.com`, and the sender-published unsubscribe URL for the one-click POST.
- No token and no token-cache content in any tool result, log line or error message.
- Nothing in the repo may say the publisher is "verified".
- stdout is reserved for JSON-RPC; every log goes to stderr.
- Node ≥ 22 (`engines`). The suite passes on Node 22 and 24, on Linux, macOS and Windows.
- Tools follow the existing style: strict zod v4 input schema, output schema, accurate annotations, thin handler wrapped in `run(...)` from `src/tools/shared.ts`.
- Tests are written first and use no real mail data (placeholder senders such as `news@x.example`).
- Conventional Commits. Each user-visible change adds a line under `Unreleased` in `CHANGELOG.md` in the task that makes it.
- A 0.1.x setup with its own `MAIL_MCP_CLIENT_ID` and existing token cache keeps working with no new sign-in.

## Review Focus

Conditions the spec implies that are most likely to bite a real user. Each has a test in the task named.

1. **Claude Desktop leaves the optional client-ID field blank** and passes `MAIL_MCP_CLIENT_ID` as `""`, as whitespace, or as the unsubstituted literal `${user_config.client_id}`. Expected: the built-in ID is used. → Task 2.
2. **The user closes the sign-in tab and asks again later.** Expected: no second browser window while the first sign-in is pending; after the give-up delay the loopback port is freed and a fresh sign-in starts cleanly. → Task 3.
3. **The user declines consent, or picks a work/school account.** Expected: `mail_login` answers `failed` with a readable reason straight away instead of waiting out the timeout. → Task 3.
4. **A token cache from another client ID is on disk** (a 0.1.x user who removed their variable). Expected: `mail_login` does not claim "already signed in"; it starts a sign-in. → Task 3.
5. **A sender publishes a hostile `mailto:` target**: extra `cc`/`bcc`/`to` parameters, line breaks, or a very long subject or body. Expected: the returned link carries only the address, subject and body, percent-encoded and capped. → Task 1.

## Owner prerequisites

Not code. The plan can start without them; the tasks that need them say so.

- A square logo, PNG, at least 512×512 (Task 5 and Task 8).
- A trusted publisher declared on npmjs.com (Task 6 gives the exact values; it expires if no publish follows within 2 days, so do it on release day).
- Approval of the wording of `PRIVACY.md` and `TERMS.md` (Task 7).

## File Structure

| File | Responsibility |
|---|---|
| `src/constants.ts` (modify) | `DEFAULT_CLIENT_ID`, `SCOPES`, `CONSENT_URL`, login timings |
| `src/unsubscribe.ts` (modify) | add `buildMailtoUrl` |
| `src/mail.ts` (modify) | new unsubscribe cascade; `unsubscribeByMail` deleted |
| `src/auth.ts` (modify) | default client ID, `signedInAccount`, `logout`, sign-in options |
| `src/session.ts` (create) | `LoginFlow` state machine, `cancelLoopback` |
| `src/tools/session.ts` (create) | `mail_login`, `mail_logout` |
| `src/tools/actions.ts`, `src/graph.ts`, `src/server.ts`, `src/index.ts` (modify) | wording, wiring, CLI |
| `mcpb/manifest.json`, `scripts/build-mcpb.mjs` (create) | Desktop bundle |
| `.github/workflows/release.yml` (create) | npm publish + bundle on tag |
| `test/auth.test.ts`, `test/session.test.ts`, `test/versions.test.ts` (create) | new suites |
| `README.md`, `PRIVACY.md`, `TERMS.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `server.json` | docs and metadata |

---

### Task 1: The server never sends email

**Files:**
- Modify: `src/unsubscribe.ts`, `src/mail.ts:52-62` and `:316-358`, `src/tools/actions.ts:108-133`, `src/constants.ts`, `src/graph.ts:27-28`
- Test: `test/unsubscribe.test.ts`, `test/mail.test.ts:127-186`

**Interfaces:**
- Produces: `buildMailtoUrl(info: UnsubscribeInfo): string | undefined` in `src/unsubscribe.ts`; `UnsubscribeOutcome.mailtoUrl?: string`; `SCOPES = ["Mail.ReadWrite"]`.

- [ ] **Step 1: Write failing tests for `buildMailtoUrl`** in `test/unsubscribe.test.ts`

```ts
describe("buildMailtoUrl", () => {
  it("returns undefined without a mailto target", () => {
    expect(buildMailtoUrl({ oneClick: false })).toBeUndefined();
  });
  it("defaults the subject to 'unsubscribe' and omits an absent body", () => {
    expect(buildMailtoUrl({ oneClick: false, mailto: "stop@x.example" })).toBe("mailto:stop@x.example?subject=unsubscribe");
  });
  it("percent-encodes subject and body", () => {
    expect(buildMailtoUrl({ oneClick: false, mailto: "stop@x.example", mailtoSubject: "Unsub me & go", mailtoBody: "a b\nc" }))
      .toBe("mailto:stop@x.example?subject=Unsub%20me%20%26%20go&body=a%20b%0Ac");
  });
  it("carries only address, subject and body from a hostile header", () => {
    const info = parseListUnsubscribe([{ name: "List-Unsubscribe", value: "<mailto:stop@x.example?cc=victim@y.example&bcc=v2@y.example&to=v3@y.example&subject=s>" }]);
    const url = buildMailtoUrl(info)!;
    expect(url).toBe("mailto:stop@x.example?subject=s");
  });
  it("encodes an address that tries to smuggle a query", () => {
    expect(buildMailtoUrl({ oneClick: false, mailto: "a@x.example?cc=v@y.example" })).not.toContain("?cc=");
  });
  it("caps subject at 200 characters and body at 1000", () => {
    const url = buildMailtoUrl({ oneClick: false, mailto: "stop@x.example", mailtoSubject: "s".repeat(500), mailtoBody: "b".repeat(5000) })!;
    const q = new URLSearchParams(url.split("?")[1]);
    expect(q.get("subject")).toHaveLength(200);
    expect(q.get("body")).toHaveLength(1000);
  });
});
```

- [ ] **Step 2: Run `npx vitest run test/unsubscribe.test.ts`** — expected: FAIL, `buildMailtoUrl` is not exported.

- [ ] **Step 3: Implement `buildMailtoUrl`** in `src/unsubscribe.ts`. Encode with `encodeURIComponent`; in the address, restore `@` only (`%40` → `@`).

- [ ] **Step 4: Run the file again** — expected: PASS.

- [ ] **Step 5: Rewrite the `MailService.unsubscribe` tests** in `test/mail.test.ts`. Keep "one-click path", "https without POST header → browser" and "no header → none" as they are. Replace the two tests that expect a send with these, and add the guard:

```ts
it("refuses one-click to a private address and hands over the URL and the mailto link, sending nothing", async () => {
  const { mail, calls } = service(() => message({ "List-Unsubscribe": "<https://192.168.1.1/unsub>, <mailto:stop@x.example>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }), neverPost);
  const r = await mail.unsubscribe("m");
  expect(r).toMatchObject({ method: "browser", ok: false, url: "https://192.168.1.1/unsub", mailto: "stop@x.example", mailtoUrl: "mailto:stop@x.example?subject=unsubscribe" });
  expect(r.detail).toContain("192.168.1.1");
  expect(calls.some((c) => c.url.includes("sendMail"))).toBe(false);
});

it("mailto-only header returns a link for the user and sends nothing", async () => {
  const { mail, calls } = service(() => message({ "List-Unsubscribe": "<mailto:stop@x.example?subject=Unsub%20me>" }));
  const r = await mail.unsubscribe("m");
  expect(r).toMatchObject({ method: "mailto", ok: false, mailto: "stop@x.example", mailtoUrl: "mailto:stop@x.example?subject=Unsub%20me" });
  expect(r.detail).toMatch(/never sends email/i);
  expect(calls.every((c) => (c.init.method ?? "GET") === "GET")).toBe(true);
});

it("https and mailto without one-click returns both", async () => {
  const { mail } = service(() => message({ "List-Unsubscribe": "<https://x.example/page>, <mailto:stop@x.example>" }));
  expect(await mail.unsubscribe("m")).toMatchObject({ method: "browser", ok: false, url: "https://x.example/page", mailtoUrl: "mailto:stop@x.example?subject=unsubscribe" });
});
```

`neverPost` is a `fetch` stand-in that fails the test if called. Add one more test at file level:

```ts
it("no source file mentions sendMail or Mail.Send", () => {
  for (const f of readdirSync(new URL("../src", import.meta.url), { recursive: true }) as string[]) {
    if (!f.endsWith(".ts")) continue;
    const text = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    expect(text, f).not.toMatch(/sendMail|Mail\.Send/);
  }
});
```

- [ ] **Step 6: Run `npx vitest run test/mail.test.ts`** — expected: the new tests FAIL.

- [ ] **Step 7: Change `MailService.unsubscribe`** in `src/mail.ts` and delete `unsubscribeByMail`. Cascade:
  1. one-click POST succeeds → `{ method: "one-click", ok: true, url }` (unchanged);
  2. an HTTPS/HTTP link exists (one-click failed or not offered) → `{ method: "browser", ok: false, url }`, plus `mailto` and `mailtoUrl` when the header also has a mailto target; `detail` keeps the one-click failure reason when there was one;
  3. mailto only → `{ method: "mailto", ok: false, mailto, mailtoUrl }` with this `detail`, verbatim: `This sender only accepts unsubscribe requests by email. Mail-MCP never sends email: give the user this link. It opens a pre-filled message in their own mail app, and they press Send.`
  4. no header → `none` (unchanged).

- [ ] **Step 8: Update the tool and the constants.** In `src/tools/actions.ts`: add `mailtoUrl: z.string().optional()` to the output schema; rewrite the description to the four cases above and state that the tool never sends email; when `method` is `mailto`, the text result starts with `✉️ Email needed for ${r.from}: ${r.mailtoUrl}`. In `src/constants.ts`: `SCOPES = ["Mail.ReadWrite"]`. In `src/graph.ts`, the 403 message names only `Mail.ReadWrite`.

- [ ] **Step 9: Run `npm run typecheck && npm test`** — expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src test CHANGELOG.md
git commit -m "feat!: stop sending email; mailto unsubscribe returns a link"
```

CHANGELOG, under `Unreleased` → `Removed`: the `mailto:` unsubscribe no longer sends; it returns a link for the user, because the recipient and text came from the sender's header. `Mail.Send` and `User.Read` are no longer requested.

---

### Task 2: Built-in client ID

**Files:**
- Modify: `src/constants.ts`, `src/auth.ts:13-21`, `server.json`
- Create: `test/auth.test.ts`

**Interfaces:**
- Produces: `DEFAULT_CLIENT_ID: string` in `src/constants.ts`; `clientId(): string` in `src/auth.ts` no longer throws.

- [ ] **Step 1: Write the failing test** `test/auth.test.ts`

```ts
describe("clientId", () => {
  const OWN = "11111111-2222-3333-4444-555555555555";
  afterEach(() => { delete process.env.MAIL_MCP_CLIENT_ID; });
  it.each([undefined, "", "   ", "${user_config.client_id}"])("falls back to the built-in ID for %j", (value) => {
    if (value === undefined) delete process.env.MAIL_MCP_CLIENT_ID; else process.env.MAIL_MCP_CLIENT_ID = value;
    expect(clientId()).toBe("599bb072-c4e2-42b1-b4e5-1d901fc08c66");
  });
  it("uses the user's own ID, trimmed", () => {
    process.env.MAIL_MCP_CLIENT_ID = ` ${OWN} `;
    expect(clientId()).toBe(OWN);
  });
});
```

- [ ] **Step 2: Run `npx vitest run test/auth.test.ts`** — expected: FAIL (throws "MAIL_MCP_CLIENT_ID is not set").

- [ ] **Step 3: Add `DEFAULT_CLIENT_ID` and change `clientId()`.** A value counts as unset when, after trimming, it is empty or starts with `${`.

- [ ] **Step 4: Run the test** — expected: PASS.

- [ ] **Step 5: Update `server.json`**: `MAIL_MCP_CLIENT_ID` gets `"isRequired": false` and the description `Optional. Application (client) ID of your own Microsoft Entra app registration. Leave unset to use the built-in Mail-MCP app.` Remove the `clientId();` pre-check line from `src/login.ts`.

- [ ] **Step 6: Run `npm run typecheck && npm test`, then commit**

```bash
git add src test server.json CHANGELOG.md
git commit -m "feat: ship a built-in Entra client ID; MAIL_MCP_CLIENT_ID becomes optional"
```

---

### Task 3: Sign-in state machine

**Files:**
- Create: `src/session.ts`, `test/session.test.ts`
- Modify: `src/auth.ts`, `src/constants.ts`

**Interfaces:**
- Consumes: `clientId()`, `getClient()`, `getAccount()` from `src/auth.ts`.
- Produces, in `src/auth.ts`:
  - `signedInAccount(): Promise<string | undefined>` — the username when a silent token acquisition succeeds, otherwise `undefined`. Never throws.
  - `logout(): Promise<{ account?: string }>` — removes every account from the MSAL cache, deletes the cache file (missing file is not an error), returns the username that was signed in, if any.
  - `loginInteractive(openBrowser)` unchanged in signature; it now passes `prompt: "select_account"` and these templates, verbatim: success `Mail-MCP is connected. You can close this tab.`, error `Mail-MCP sign-in failed. Go back to Claude and try again.`
- Produces, in `src/session.ts`:

```ts
export type LoginStatus =
  | { status: "signed_in"; account: string }
  | { status: "pending"; url: string }
  | { status: "failed"; detail: string };

export interface LoginDeps {
  signedInAccount(): Promise<string | undefined>;
  loginInteractive(openBrowser: (url: string) => Promise<void>): Promise<{ username: string }>;
  openBrowser(url: string): Promise<void>;
  cancel(authUrl: string): Promise<void>;
  waitMs: number;    // production: LOGIN_WAIT_MS = 45_000
  giveUpMs: number;  // production: LOGIN_GIVE_UP_MS = 300_000
}

export class LoginFlow {
  constructor(deps: LoginDeps);
  start(): Promise<LoginStatus>;
}

/** Ends an abandoned MSAL loopback sign-in by posting an OAuth error to its redirect URI. */
export function cancelLoopback(authUrl: string, fetchImpl?: typeof fetch): Promise<void>;
```

- Produces, in `src/constants.ts`: `LOGIN_WAIT_MS`, `LOGIN_GIVE_UP_MS`, `CONSENT_URL = "https://microsoft.com/consent"`.

Behaviour of `LoginFlow.start()`, in order:
1. `signedInAccount()` returns a name → `signed_in`. No browser.
2. A sign-in is already in flight → wait up to `waitMs` on that same sign-in; never call `openBrowser` again.
3. Otherwise start `loginInteractive`. The wrapper passed to it records the URL, calls `deps.openBrowser` and swallows its error (the URL is returned anyway), and arms an unref'd timer that calls `deps.cancel(url)` after `giveUpMs`.
4. Resolved within `waitMs` → `signed_in`. Rejected → `failed`, `detail` = first line of the error message, in-flight state cleared. Still running → `pending` with the URL.
5. When an in-flight sign-in settles later, the in-flight state and the timer are cleared. If it settled with a failure that no call has reported yet, the next `start()` returns that `failed` status once, without opening a window; the call after that starts fresh.

`cancelLoopback` reads `redirect_uri` from the authorization URL and sends `POST` to it with `Content-Type: application/x-www-form-urlencoded` and body `error=login_timeout&error_description=Sign-in+was+not+completed+in+time`. MSAL 7's loopback server turns that into a rejected sign-in and closes its port; MSAL offers no other way to abort. It must refuse any `redirect_uri` whose host is not `localhost` or `127.0.0.1`.

- [ ] **Step 1: Write the failing tests** in `test/session.test.ts`. Use real timers with `waitMs: 30`, `giveUpMs: 80`. `deferred()` is a helper returning `{ promise, resolve, reject }`. `deps(overrides)` builds a `LoginDeps` from recording fakes and exposes `opened: string[]`, `cancelled: string[]` and `loginCalls: number`; its `login` override becomes `loginInteractive`, and `signedInAccount` defaults to `async () => undefined`. `URL_A` is `https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A50123`.

```ts
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
  const d = deps({ login: async (open) => { await open(URL_A); return new Promise(() => {}); }, openBrowser: async () => { throw new Error("no display"); } });
  expect(await new LoginFlow(d).start()).toEqual({ status: "pending", url: URL_A });
});

it("declined consent fails at once with the first line of the reason", async () => {
  const d = deps({ login: async (open) => { await open(URL_A); throw new Error("access_denied: The user has denied access.\nTrace ID: 123"); } });
  expect(await new LoginFlow(d).start()).toEqual({ status: "failed", detail: "access_denied: The user has denied access." });
});

it("gives up after giveUpMs, cancels the loopback, and the next call starts a fresh sign-in", async () => {
  const gate = deferred<{ username: string }>();
  const d = deps({ login: async (open) => { await open(URL_A); return gate.promise; }, cancel: async () => { gate.reject(new Error("login_timeout")); } });
  const flow = new LoginFlow(d);
  await flow.start();
  await sleep(120);
  expect(d.cancelled).toEqual([URL_A]);
  await flow.start();
  expect(d.loginCalls).toBe(2);
});

it("a stale cache from another client ID does not count as signed in", async () => {
  const d = deps({ signedInAccount: async () => undefined, login: async (open) => { await open(URL_A); return { username: "a@outlook.com" }; } });
  await new LoginFlow(d).start();
  expect(d.loginCalls).toBe(1);
});

describe("cancelLoopback", () => {
  it("posts an OAuth error to the loopback redirect URI", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    await cancelLoopback(URL_A, (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response(""); }) as unknown as typeof fetch);
    expect(seen[0]!.url).toBe("http://localhost:50123/");
    expect(seen[0]!.init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(String(seen[0]!.init.body)).toContain("error=login_timeout");
  });
  it("refuses a redirect URI that is not loopback", async () => {
    let called = false;
    await cancelLoopback("https://login.microsoftonline.com/x?redirect_uri=https%3A%2F%2Fevil.example%2F", (async () => { called = true; return new Response(""); }) as unknown as typeof fetch);
    expect(called).toBe(false);
  });
});
```

- [ ] **Step 2: Add the MSAL guard test** to `test/session.test.ts`. It protects the cancel trick against a future MSAL upgrade: build a real `PublicClientApplication` (client ID `DEFAULT_CLIENT_ID`, authority `consumers`), call `acquireTokenInteractive` with an `openBrowser` that captures the URL, call the real `cancelLoopback(url)`, and assert the promise rejects with a message containing `login_timeout` within 2 seconds. The test must not use the network: if MSAL performs authority discovery, answer it from a stub `INetworkModule` passed as `system.networkClient`.

- [ ] **Step 3: Run `npx vitest run test/session.test.ts`** — expected: FAIL, module `../src/session.js` not found.

- [ ] **Step 4: Implement `src/session.ts`, the three `src/auth.ts` additions and the constants.** Update the `AuthError` messages in `src/auth.ts` and the 401 text in `src/graph.ts` to, verbatim: `Not signed in. Call the mail_login tool to sign the user in.` (expired or invalid token: `The sign-in has expired. Call the mail_login tool to sign the user in again.`).

- [ ] **Step 5: Add `logout` tests** to `test/auth.test.ts`: with `MAIL_MCP_CACHE_PATH` pointing at a temp file that exists, `logout()` resolves and the file is gone; with no file, `logout()` resolves to `{}`. The auth module caches its MSAL client; give the tests whatever seam they need to start from a fresh one.

- [ ] **Step 6: Run `npm run typecheck && npm test`** — expected: PASS on all files.

- [ ] **Step 7: Commit**

```bash
git add src test CHANGELOG.md
git commit -m "feat: single-flight sign-in flow with give-up, and logout"
```

CHANGELOG → `Fixed`: the sign-in result page showed raw HTML since 0.1.2.

---

### Task 4: `mail_login`, `mail_logout` and the CLI

**Files:**
- Create: `src/tools/session.ts`
- Modify: `src/server.ts`, `src/index.ts`, `src/login.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `LoginFlow`, `LoginStatus`, `cancelLoopback` from `src/session.ts`; `signedInAccount`, `loginInteractive`, `logout` from `src/auth.ts`; `CONSENT_URL`, `LOGIN_WAIT_MS`, `LOGIN_GIVE_UP_MS`.
- Produces:

```ts
export interface SessionService {
  login(): Promise<LoginStatus>;
  logout(): Promise<{ account?: string }>;
}
export function registerSessionTools(server: McpServer, session: SessionService): void;
// src/server.ts
export function buildServer(mail?: MailService, session?: SessionService): McpServer;
```

Tool contracts:

| | `mail_login` | `mail_logout` |
|---|---|---|
| input | `z.object({}).strict()` | `z.object({}).strict()` |
| output | `{ status: "signed_in" \| "pending" \| "failed", account?: string, url?: string, detail: string }` | `{ signedOut: boolean, account?: string, revokeUrl: string, detail: string }` |
| annotations | `readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true` | `readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false` |

`detail` texts, verbatim:
- signed in: `Signed in as ${account}.`
- pending: `A Microsoft sign-in page was opened in the user's browser. Ask them to finish signing in there, then call mail_login again. If no page opened, give them this link: ${url}`
- failed: `Sign-in did not complete: ${detail} Call mail_login to try again.`
- logout, when an account was signed in (`signedOut: true`): `Signed out of ${account}. The local sign-in was removed. To also withdraw Mail-MCP's access on Microsoft's side, the user can open ${CONSENT_URL}.`
- logout, when none was (`signedOut: false`): `No account was signed in. To withdraw Mail-MCP's access on Microsoft's side, the user can open ${CONSENT_URL}.`

`mail_login`'s description must say that it never asks for permission to send email and that it should be called when any other tool answers "Not signed in".

- [ ] **Step 1: Write the failing test** in `test/server.test.ts`: build the server with a fake `MailService` stand-in and a fake `SessionService`, connect it to one end of `InMemoryTransport.createLinkedPair()` (exported by `@modelcontextprotocol/server`), send `initialize`, `tools/list` and `tools/call` as raw JSON-RPC from the other end, and assert:
  - `tools/list` returns exactly these 11 names: the nine existing ones plus `mail_login` and `mail_logout`;
  - calling `mail_login` with the fake returning `{ status: "pending", url: "https://login.microsoftonline.com/x" }` yields `structuredContent.status === "pending"` and a text containing that URL;
  - calling `mail_logout` yields `structuredContent.revokeUrl === "https://microsoft.com/consent"`;
  - when the fake `logout()` returns an extra, unexpected property (`{ account: "a@outlook.com", accessToken: "eyJsecret" }`), neither the text nor the structured content of the result contains `eyJsecret`: the handlers copy only the fields listed above.

- [ ] **Step 2: Run `npx vitest run test/server.test.ts`** — expected: FAIL.

- [ ] **Step 3: Implement `src/tools/session.ts` and wire `buildServer`.** The default `SessionService` builds one `LoginFlow` per process with `openBrowser` from the `open` package and `cancel: cancelLoopback`.

- [ ] **Step 4: Update the CLI** in `src/index.ts`: add `logout` (prints the logout `detail` to stderr); `--help` lists `login`, `logout`, `--version` and no longer says the client ID is needed.

- [ ] **Step 5: Run `npm run typecheck && npm test && npm run build`**, then check by hand:

```bash
node dist/index.js --help
node dist/index.js logout
```

Expected: help lists the server, `login`, `logout` and `--version`; logout prints one of the two logout texts with the consent URL, exit code 0. Run `logout` with `MAIL_MCP_CACHE_PATH` set to a scratch path so a real sign-in on the machine is not removed.

- [ ] **Step 6: Commit**

```bash
git add src test CHANGELOG.md
git commit -m "feat: mail_login and mail_logout tools, mail-mcp logout"
```

---

### Task 5: Claude Desktop bundle

**Files:**
- Create: `mcpb/manifest.json`, `mcpb/icon.png` (owner-supplied), `scripts/build-mcpb.mjs`, `test/versions.test.ts`
- Modify: `package.json` (script `build:mcpb`, dev dependency `@anthropic-ai/mcpb@^2.1.2`), `.gitignore` (`build/`, `*.mcpb`), `.github/workflows/ci.yml`

**Interfaces:**
- Produces: `npm run build:mcpb` writes `mail-mcp-<version>.mcpb` at the repo root and prints its path.

- [ ] **Step 1: Write the failing test** `test/versions.test.ts`: `package.json` version equals `server.json` `version`, `server.json` `packages[0].version`, and `mcpb/manifest.json` `version`; the manifest's `tools[].name` list equals the 11 tool names, in any order; the manifest's `server.mcp_config.env` is exactly `{ "MAIL_MCP_CLIENT_ID": "${user_config.client_id}" }`.

- [ ] **Step 2: Run it** — expected: FAIL, manifest missing.

- [ ] **Step 3: Write `mcpb/manifest.json`.** Read the current specification first (`https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md`); on 2026-11-16 it gave `manifest_version` `"0.3"`. Values this plan fixes:
  - `name`: `mail-mcp`; `display_name`: `Mail-MCP (Outlook.com / Hotmail)`; `version`: same as `package.json`; `author.name`: `Rixtayz`; `license`: `MIT`.
  - `server`: `type` `node`, `entry_point` `dist/index.js`, `mcp_config.command` `node`, `args` `["${__dirname}/dist/index.js"]`, `env` as in the test.
  - `user_config.client_id`: `type` `string`, `required` `false`, `default` `""`, `title` `Your own Entra client ID (advanced)`, `description` `Leave empty to use the built-in Mail-MCP app.`
  - `privacy_policies`: `["https://github.com/Rixtayz/Mail-MCP/blob/main/PRIVACY.md"]`; `repository`, `homepage`, `support` point at the GitHub repo.
  - `icon`: `icon.png`. Until the owner supplies the logo, omit the field and leave a `TODO(owner logo)` line in the task's pull-request description, not in the code.
  - No `compatibility.runtimes` entry: Claude Desktop runs the bundle on its own Node, and the acceptance run in Task 8 is what proves it works there.

- [ ] **Step 4: Write `scripts/build-mcpb.mjs`.** It stages `build/mcpb/` with `manifest.json`, the icon if present, `package.json`, `package-lock.json` and `dist/`; runs `npm ci --omit=dev --ignore-scripts` inside the staging folder; runs `mcpb validate` then `mcpb pack` on it (confirm the exact sub-commands with `npx mcpb --help`). `dist/constants.js` reads `../package.json`, so `package.json` must sit next to `dist/` in the bundle.

- [ ] **Step 5: Run `npm test && npm run build && npm run build:mcpb`** — expected: tests PASS, a `.mcpb` file of a few megabytes, `mcpb validate` reports no error.

- [ ] **Step 6: Smoke-test the staged server**

```bash
node build/mcpb/dist/index.js --version
```

Expected: the version from `package.json`.

- [ ] **Step 7: Add `npm run build:mcpb` to `ci.yml`** on `ubuntu-latest` / Node 24 only, after the build step. Commit.

```bash
git add mcpb scripts test package.json package-lock.json .gitignore .github/workflows/ci.yml CHANGELOG.md
git commit -m "feat: Claude Desktop extension bundle (.mcpb)"
```

---

### Task 6: Release workflow with npm provenance

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `CONTRIBUTING.md` (section "Releasing (maintainer)")

**Interfaces:**
- Consumes: `npm run build:mcpb` from Task 5.
- Produces: pushing a tag `vX.Y.Z` publishes `@rixtay/mail-mcp@X.Y.Z` to npm with provenance and creates a GitHub release carrying `mail-mcp-X.Y.Z.mcpb`.

- [ ] **Step 1: Write `.github/workflows/release.yml`**
  - Trigger: `on: push: tags: ['v*']`. Not `workflow_dispatch`: npm's trusted-publisher validation can reject manual runs.
  - First step after checkout fails unless `GITHUB_REF_NAME` equals `v` + the `package.json` version.
  - Job `npm`: `permissions: { id-token: write, contents: read }`, `actions/setup-node` with Node 24 and `registry-url: https://registry.npmjs.org`, a step that fails if `npm --version` is below 11.5.1, `npm ci`, `npm publish`. No `NODE_AUTH_TOKEN`, no `--provenance` flag (provenance is automatic with trusted publishing from a public repo). `prepublishOnly` already runs typecheck, tests and build.
  - Job `bundle`, `needs: npm`, `permissions: { contents: write }`: `npm ci`, `npm run build`, `npm run build:mcpb`, then create the GitHub release for the tag with the `.mcpb` attached and the matching `CHANGELOG.md` section as notes.
  - Pin third-party actions by major version, as the existing workflows do.

- [ ] **Step 2: Check the workflow parses**

```bash
npx --yes action-validator .github/workflows/release.yml
```

Expected: no error. If the validator cannot run, say so in the task report instead of claiming the workflow was validated. The workflow's first real run is the 0.2.0 tag in Task 8.

- [ ] **Step 3: Rewrite "Releasing (maintainer)" in `CONTRIBUTING.md`**: bump `package.json`, both `server.json` version fields and `mcpb/manifest.json`; `npm install --package-lock-only`; move the changelog entries; commit; tag and push; the workflow publishes; then run **Publish to MCP Registry** by hand as before. Add the one-time npm setup, with these exact values: npmjs.com → package `@rixtay/mail-mcp` → Settings → Trusted publishing → GitHub Actions; user `Rixtayz`, repository `Mail-MCP`, workflow filename `release.yml`, no environment, allow `npm publish`. Note that the setting lapses if no publish validates it within 2 days.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml CONTRIBUTING.md CHANGELOG.md
git commit -m "ci: publish to npm with provenance and attach the .mcpb on tag"
```

---

### Task 7: Documentation and version 0.2.0

**Files:**
- Modify: `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`, `server.json`, `mcpb/manifest.json`
- Create: `PRIVACY.md`, `TERMS.md`

**Interfaces:**
- Consumes: tool names and behaviours from Tasks 1–4; install paths from Tasks 5–6.

- [ ] **Step 1: Rewrite `README.md`** in this order, keeping the badges, hero image and tool table (now 11 tools):
  1. One-paragraph pitch; the line "Mail-MCP cannot send email" in the design choices.
  2. **Quick start — Claude Desktop**: download `mail-mcp-<version>.mcpb` from the latest GitHub release, double-click, install, then say "connect my Outlook".
  3. **Claude Code**: `claude mcp add --scope user --transport stdio mail -- npx -y @rixtay/mail-mcp`.
  4. **Other MCP clients**: the JSON block without `env`.
  5. **Security and privacy**, covering each of: the author operates no server and receives no data; the three hosts contacted (Global Constraints); the three lines of the Microsoft consent screen and why each is there; "does not include permission to send"; the token cache location and file mode; `mail_logout` / `mail-mcp logout` and `https://microsoft.com/consent`; how to check npm provenance; that Microsoft currently labels the app "unverified" and what that means.
  6. **Use your own Entra app** (advanced), four steps: new registration; name; "Personal Microsoft accounts only"; redirect URI `http://localhost` on "Mobile and desktop applications". Then set `MAIL_MCP_CLIENT_ID`, shown for bash and for PowerShell (`$env:MAIL_MCP_CLIENT_ID = "<id>"`).
  7. **Upgrading from 0.1.x**: nothing to do; to shed the old send permission, sign out, remove the app at `https://microsoft.com/consent`, sign in again.
  8. Example prompts, development, things worth knowing (drop the `mailto:` send remarks; `msal-node` is v7), contributing, license.

- [ ] **Step 2: Write `PRIVACY.md` and `TERMS.md`**, each under 40 lines, plain language. `PRIVACY.md`: who publishes the Entra app (Les Solutions Devforge inc); the software runs on the user's machine; the publisher collects nothing, runs no server and has no access to mail or tokens; which Microsoft services the software talks to; how to revoke; contact through GitHub issues. `TERMS.md`: MIT licence, no warranty, the user is responsible for actions taken on their mailbox, link to the licence. The sentence about what the publisher can see in its own Microsoft tenant is written only after the Task 8 check and must state exactly what was observed.

- [ ] **Step 3: Update `SECURITY.md` and `CONTRIBUTING.md`.** `SECURITY.md`: the promise becomes "never sends email and never asks for the permission to"; any path that sends mail is reportable; add `mail_login` / `mail_logout` (a result that contains a token is reportable). `CONTRIBUTING.md` ground rule 3 becomes "No sending, at all"; the setup paragraph no longer requires an Entra app.

- [ ] **Step 4: Bump to 0.2.0** in `package.json`, `server.json` (both fields), `mcpb/manifest.json`; run `npm install --package-lock-only`; move `Unreleased` to `## [0.2.0] - <release date>` with `Added`, `Changed`, `Removed`, `Fixed`, and update the compare links.

- [ ] **Step 5: Verify**

```bash
npm run typecheck && npm test && npm run build && npm run build:mcpb
```

Expected: all pass. Then search the repo for stale claims:

```bash
git grep -n -i -E "sendMail|msal-node. v6|allow public client flows" -- . ":!docs/superpowers" ":!CHANGELOG.md"
```

Expected: no match. Then read every sentence in `README.md`, `PRIVACY.md` and `mcpb/manifest.json` that contains "verified" and confirm none claims the publisher is verified.

- [ ] **Step 6: Commit**

```bash
git add README.md PRIVACY.md TERMS.md SECURITY.md CONTRIBUTING.md CHANGELOG.md package.json package-lock.json server.json mcpb/manifest.json
git commit -m "docs: zero-setup README, privacy and terms; release 0.2.0"
```

---

### Task 8: Acceptance and release (with the owner)

No code. Each line is checked off with the owner; a failure reopens the task that owns the behaviour.

- [ ] **Step 1:** Owner reads and approves `PRIVACY.md` and `TERMS.md`.
- [ ] **Step 2:** Manual acceptance on Windows with a personal account that does not own the Entra app, items 1–6 of the spec's Testing section, using the locally built `.mcpb`.
- [ ] **Step 3:** The day after step 2, look at the Mail-MCP enterprise application in the DevForge Entra tenant ("Users and groups", "Sign-in logs"). Write the observed result into `PRIVACY.md` and the README; if anything about the test account is visible, say exactly what.
- [ ] **Step 4:** Merge `PRIVACY.md` / `TERMS.md` to `main`, then set the Entra app branding: logo, home page `https://github.com/Rixtayz/Mail-MCP`, terms `https://github.com/Rixtayz/Mail-MCP/blob/main/TERMS.md`, privacy `https://github.com/Rixtayz/Mail-MCP/blob/main/PRIVACY.md`. Sign in once more and confirm the consent screen shows the logo and no longer says the publisher gave no terms link.
- [ ] **Step 5:** Owner declares the npm trusted publisher (values in `CONTRIBUTING.md`), then tags `v0.2.0` and pushes. Confirm: the npm page shows provenance, the GitHub release carries the `.mcpb`, `npx -y @rixtay/mail-mcp@0.2.0 --version` prints `0.2.0`.
- [ ] **Step 6:** Run **Publish to MCP Registry**.
- [ ] **Step 7:** Retry publisher verification in Entra. Its outcome changes one README sentence and nothing else.
