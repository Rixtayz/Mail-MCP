import { describe, expect, it } from "vitest";
import { GraphClient, chunkArray, odataString, pathSegment } from "../src/graph.js";

type Call = { url: string; init: RequestInit };

function mockFetch(handler: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler({ url, init }, calls.length);
  }) as unknown as typeof fetch;
  return { f, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const client = (f: typeof fetch) =>
  new GraphClient({ getToken: async () => "tok", fetchImpl: f, sleep: async () => {} });

describe("GraphClient.request", () => {
  it("adds bearer auth and parses JSON", async () => {
    const { f, calls } = mockFetch(() => json({ value: [1] }));
    const r = await client(f).get<{ value: number[] }>("/me/messages");
    expect(r.value).toEqual([1]);
    expect(calls[0]?.url).toBe("https://graph.microsoft.com/v1.0/me/messages");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("retries on 429 using Retry-After then succeeds", async () => {
    const { f, calls } = mockFetch((_c, n) => (n < 3 ? json({}, 429, { "Retry-After": "1" }) : json({ ok: true })));
    const r = await client(f).get<{ ok: boolean }>("/me");
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(3);
  });

  it.each([
    ["1", 1_000],
    ["2.5", 2_500],
    ["60", 60_000],
    ["61", 60_000],
    ["3600", 60_000],
    ["1e9", 60_000],
  ])("waits what Retry-After %s asks, but never more than 60 s", async (header, wait) => {
    const waits: number[] = [];
    const { f } = mockFetch((_c, n) => (n === 1 ? json({}, 503, { "Retry-After": header }) : json({ ok: true })));
    const g = new GraphClient({ getToken: async () => "tok", fetchImpl: f, sleep: async (ms) => void waits.push(ms) });
    await g.get("/me");
    expect(waits).toEqual([wait]);
  });

  // mail_login answers "Signed in" whenever a silent token works, so a retry can hit the same error:
  // both texts must offer a way out of that loop, and carry what Microsoft said.
  it("maps 401 to mail_login, with Microsoft's code and message, and a way out of a login loop", async () => {
    const { f } = mockFetch(() => json({ error: { code: "InvalidAuthenticationToken", message: "Access token has expired or is not yet valid." } }, 401));
    const err = await client(f).get("/me").then(() => undefined, (e: unknown) => e as Error);
    expect(err?.message).toBe(
      "Microsoft rejected the sign-in (401, InvalidAuthenticationToken): Access token has expired or is not yet valid. " +
        "Call the mail_login tool to sign the user in again. If this keeps happening, call mail_logout, then mail_login.",
    );
  });

  it("maps 403 to Microsoft's code and message, without guessing a cause, and a way out of a login loop", async () => {
    const { f } = mockFetch(() => json({ error: { code: "ErrorAccessDenied", message: "Access is denied. Check credentials and try again." } }, 403));
    const err = await client(f).get("/me").then(() => undefined, (e: unknown) => e as Error);
    expect(err?.message).toBe(
      "Microsoft refused the request (403, ErrorAccessDenied): Access is denied. Check credentials and try again. " +
        "If this keeps happening, call mail_logout, then mail_login.",
    );
    expect(err?.message).not.toMatch(/Mail\.ReadWrite|permission/);
  });

  it("401 and 403 texts read well without a code, or with a message that has no final period", async () => {
    const { f } = mockFetch((_c, n) => (n === 1 ? new Response("", { status: 401 }) : json({ error: { message: "nope" } }, 403)));
    const g = client(f);
    const first = await g.get("/me").then(() => undefined, (e: unknown) => e as Error);
    expect(first?.message).toBe(
      "Microsoft rejected the sign-in (401). Call the mail_login tool to sign the user in again. If this keeps happening, call mail_logout, then mail_login.",
    );
    const second = await g.get("/me").then(() => undefined, (e: unknown) => e as Error);
    expect(second?.message).toBe("Microsoft refused the request (403): nope. If this keeps happening, call mail_logout, then mail_login.");
  });

  it("maps 404 to an actionable error", async () => {
    const { f } = mockFetch(() => json({ error: { code: "ErrorItemNotFound", message: "nope" } }, 404));
    await expect(client(f).get("/me/messages/x")).rejects.toThrow(/Not found \(404\)/);
  });

  it("returns undefined on 204", async () => {
    const { f } = mockFetch(() => new Response(null, { status: 204 }));
    await expect(client(f).delete("/me/messages/x")).resolves.toBeUndefined();
  });
});

describe("GraphClient.paginate", () => {
  it("follows nextLink verbatim and honours maxItems", async () => {
    const { f, calls } = mockFetch((c) =>
      c.url.includes("skiptoken")
        ? json({ value: [3, 4] })
        : json({ value: [1, 2], "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=abc" }),
    );
    const out: number[] = [];
    for await (const x of client(f).paginate<number>("/me/messages?$top=2")) out.push(x);
    expect(out).toEqual([1, 2, 3, 4]);
    expect(calls[1]?.url).toBe("https://graph.microsoft.com/v1.0/me/messages?$skiptoken=abc");

    const limited: number[] = [];
    for await (const x of client(f).paginate<number>("/me/messages?$top=2", 3)) limited.push(x);
    expect(limited).toEqual([1, 2, 3]);
  });
});

const REFUSED = "Refused to call a URL outside Microsoft Graph. Pass back the cursor exactly as mail_search returned it.";

describe("GraphClient never sends the token outside Microsoft Graph", () => {
  const hostile = [
    "https://attacker.example/x",
    "https://graph.microsoft.com.attacker.example/v1.0/me/messages",
    "https://graph.microsoft.com/v1.0@attacker.example/me",
    "https://user:pass@graph.microsoft.com/v1.0/me",
    "https://graph.microsoft.com:8443/v1.0/me",
    "http://graph.microsoft.com/v1.0/me",
    "https://graph.microsoft.com/beta/me",
    "https://graph.microsoft.com/v1.0evil/me",
  ];

  it.each(hostile)("refuses %s before any network call, without echoing it", async (url) => {
    const { f, calls } = mockFetch(() => json({ value: [] }));
    const err = await client(f).get(url).then(() => undefined, (e: unknown) => e as Error);
    expect(err?.message).toBe(REFUSED);
    expect(err?.message).not.toContain("attacker");
    expect(err?.message).not.toContain("tok");
    expect(calls).toHaveLength(0);
  });

  it("accepts a real Graph URL whatever the case of scheme and host, and fetches the normalised URL", async () => {
    const { f, calls } = mockFetch(() => json({ value: [] }));
    await client(f).get("HTTPS://GRAPH.MICROSOFT.COM/v1.0/me");
    expect(calls.map((c) => c.url)).toEqual(["https://graph.microsoft.com/v1.0/me"]);
  });

  it("keeps relative paths working", async () => {
    const { f, calls } = mockFetch(() => json({ value: [] }));
    await client(f).get("me/messages?$top=1");
    expect(calls[0]?.url).toBe("https://graph.microsoft.com/v1.0/me/messages?$top=1");
  });

  const escapes = ["../beta/me", "/../beta/me", "/%2e%2e/beta/me", "../../..//attacker.example/x"];

  it.each(escapes)("refuses the relative path %s that leaves /v1.0, without a network call", async (path) => {
    const { f, calls } = mockFetch(() => json({ value: [] }));
    const err = await client(f).get(path).then(() => undefined, (e: unknown) => e as Error);
    expect(err?.message).toBe(REFUSED);
    expect(err?.message).not.toContain("attacker");
    expect(calls).toHaveLength(0);
  });

  // A relative path is relative to the base, so /v1.0/../beta/me means /v1.0/v1.0/../beta/me: it stays under /v1.0.
  it("keeps a relative path that dot-segments back inside /v1.0 under /v1.0", async () => {
    const { f, calls } = mockFetch(() => json({ value: [] }));
    await client(f).get("/v1.0/../beta/me");
    expect(calls.map((c) => c.url)).toEqual(["https://graph.microsoft.com/v1.0/beta/me"]);
  });

  // Already refused before the hardening; pinned so a parser change cannot reopen them.
  const parserTricks = [
    "https://graph.microsoft.com./v1.0/me",
    "https://graph.microsoft.com\@attacker.example/v1.0/me",
    "https://graph.micro	soft.com.attacker.example/v1.0/me",
    "https://graph.microsoft.com/v1.0/%2e%2e/beta/me",
  ];

  it.each(parserTricks)("keeps refusing the parser trick %j", async (url) => {
    const { f, calls } = mockFetch(() => json({ value: [] }));
    const err = await client(f).get(url).then(() => undefined, (e: unknown) => e as Error);
    expect(err?.message).toBe(REFUSED);
    expect(calls).toHaveLength(0);
  });

  it("sends the same request URL as before for the paths mail.ts builds", async () => {
    const { f, calls } = mockFetch(() => json({ value: [] }));
    const g = client(f);
    const filter = encodeURIComponent("from/emailAddress/address eq \"a@b.com\" and receivedDateTime ge 2026-01-01T00:00:00Z");
    await g.get("/me/mailFolders?$top=250");
    await g.get(`/me/mailFolders/AAMkAD=-_x/messages?$select=id,subject&$top=10&$filter=${filter}&$orderby=${encodeURIComponent("receivedDateTime desc")}`);
    await g.get(`/me/messages/${encodeURIComponent("AAMk/+=")}?$select=id,subject,body`);
    await g.get(`/me/messages?$search=${encodeURIComponent('"a b"')}`);
    expect(calls.map((c) => c.url)).toEqual([
      "https://graph.microsoft.com/v1.0/me/mailFolders?$top=250",
      "https://graph.microsoft.com/v1.0/me/mailFolders/AAMkAD=-_x/messages?$select=id,subject&$top=10&$filter=from%2FemailAddress%2Faddress%20eq%20%22a%40b.com%22%20and%20receivedDateTime%20ge%202026-01-01T00%3A00%3A00Z&$orderby=receivedDateTime%20desc",
      "https://graph.microsoft.com/v1.0/me/messages/AAMk%2F%2B%3D?$select=id,subject,body",
      "https://graph.microsoft.com/v1.0/me/messages?$search=%22a%20b%22",
    ]);
  });

  // new URL() writes a literal ' in a query as %27, which is what fetch puts on the wire for the raw form too.
  it("sends a quoted $filter value exactly as fetch would have on the wire", async () => {
    const { f, calls } = mockFetch(() => json({ value: [] }));
    await client(f).get(`/me/mailFolders/inbox/messages?$filter=${encodeURIComponent(`from/emailAddress/address eq ${odataString("o'neil@x.com")}`)}`);
    expect(calls[0]?.url).toBe(
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$filter=from%2FemailAddress%2Faddress%20eq%20%27o%27%27neil%40x.com%27",
    );
  });

  it("never follows a redirect, on plain requests and on $batch", async () => {
    const { f, calls } = mockFetch((c) => (c.url.endsWith("/$batch") ? json({ responses: [{ id: "a", status: 204 }] }) : json({ value: [] })));
    const g = client(f);
    await g.get("/me/messages");
    await g.post("/me/messages/x/move", { destinationId: "y" });
    await g.delete("/me/messages/x");
    await g.batch([{ id: "a", method: "DELETE", url: "/me/messages/x" }]);
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(calls.map((c) => c.init.redirect)).toEqual(calls.map(() => "error"));
  });

  it("follows a real @odata.nextLink in paginate", async () => {
    const next = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=50&$top=50";
    const { f, calls } = mockFetch((_c, n) => (n === 1 ? json({ value: [1], "@odata.nextLink": next }) : json({ value: [2] })));
    const out: number[] = [];
    for await (const x of client(f).paginate<number>("/me/messages")) out.push(x);
    expect(out).toEqual([1, 2]);
    expect(calls[1]?.url).toBe(next);
  });

  it("stops paginating on a hostile @odata.nextLink and never fetches it", async () => {
    const { f, calls } = mockFetch((_c, n) => (n === 1 ? json({ value: [1], "@odata.nextLink": "https://attacker.example/steal" }) : json({ value: [2] })));
    const out: number[] = [];
    const run = async () => {
      for await (const x of client(f).paginate<number>("/me/messages")) out.push(x);
    };
    await expect(run()).rejects.toThrow(REFUSED);
    expect(out).toEqual([1]);
    expect(calls).toHaveLength(1);
  });
});

describe("GraphClient.batch", () => {
  type Sent = { id: string; url: string };
  const sentIn = (c: Call) => (JSON.parse(c.init.body as string) as { requests: Sent[] }).requests;

  it("chunks into 20, preserves order, and retries throttled sub-requests", async () => {
    let batchCalls = 0;
    const { f } = mockFetch(async (c) => {
      batchCalls++;
      return json({ responses: sentIn(c).map((r) => ({ id: r.id, status: batchCalls === 1 && r.url === "/me/messages/3" ? 429 : 204 })) });
    });
    const reqs = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, method: "DELETE" as const, url: `/me/messages/${i}` }));
    const res = await client(f).batch(reqs);
    expect(res.length).toBe(25);
    expect(res.map((r) => r.id)).toEqual(reqs.map((r) => r.id));
    expect(res.every((r) => r.status === 204)).toBe(true);
    expect(batchCalls).toBe(3); // 20 + 5, then 1 retry for /me/messages/3
  });

  it("sends each request under its index, whatever the caller's id, and answers under the caller's id", async () => {
    const longId = "AAMkAGVmMDEzMTM4LTZmYWUtNDdkNC1hMDZiLTU1OGY5OTZhYmY4OABGAAAAAAAiQ8W967B7TKBjgx9rVEURBwAiIsqMbYjsT5e-T7KzowPTAAAAAAEMAAAiIsqMbYjsT5e-T7KzowPTAASoXUT3AAA=";
    const { f, calls } = mockFetch((c) => json({ responses: sentIn(c).map((r) => ({ id: r.id, status: 200, body: { url: r.url } })) }));
    const reqs = Array.from({ length: 22 }, (_, i) => ({ id: i === 0 ? longId : `caller-${i}`, method: "GET" as const, url: `/me/messages/m${i}` }));
    const res = await client(f).batch(reqs);
    expect(calls.map((c) => sentIn(c).map((r) => r.id))).toEqual([
      Array.from({ length: 20 }, (_, i) => String(i)),
      ["20", "21"],
    ]);
    expect(res.map((r) => r.id)).toEqual(reqs.map((r) => r.id));
    expect(res.map((r) => (r.body as { url: string }).url)).toEqual(reqs.map((r) => r.url));
  });

  it("keeps a response apart from another chunk's request that shares its index", async () => {
    // Graph answers the second chunk with an id that only the first chunk used: it must not overwrite that answer.
    const { f } = mockFetch((c, n) =>
      json({ responses: n === 1 ? sentIn(c).map((r) => ({ id: r.id, status: 204 })) : [{ id: "0", status: 404 }, { id: "20", status: 201 }] }),
    );
    const reqs = Array.from({ length: 21 }, (_, i) => ({ id: `r${i}`, method: "DELETE" as const, url: `/me/messages/${i}` }));
    const res = await client(f).batch(reqs);
    expect(res[0]).toEqual({ id: "r0", status: 204 });
    expect(res[20]).toEqual({ id: "r20", status: 201 });
  });
});

const INVALID_ID = "Refused an id that is not one Microsoft Graph gave: pass ids exactly as mail_search, mail_senders_summary or mail_list_folders returned them.";

describe("helpers", () => {
  it("chunkArray", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("odataString escapes quotes", () => {
    expect(odataString("o'neil@x.com")).toBe("'o''neil@x.com'");
  });

  it("pathSegment keeps an id inside its one path segment", () => {
    expect(pathSegment("AAMkADhAAAW-VPeAAA=")).toBe("AAMkADhAAAW-VPeAAA%3D");
    expect(pathSegment("AAMkADhAAAW/VPeAAA=")).toBe("AAMkADhAAAW%2FVPeAAA%3D");
    expect(pathSegment("a+b?c#d%2e")).toBe("a%2Bb%3Fc%23d%252e");
    expect(pathSegment("inbox")).toBe("inbox");
  });

  it.each(["", ".", ".."])("pathSegment refuses %j, which would name another resource", (id) => {
    expect(() => pathSegment(id)).toThrow(INVALID_ID);
  });
});
