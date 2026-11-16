import { describe, expect, it } from "vitest";
import { GraphClient, chunkArray, odataString } from "../src/graph.js";

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

describe("GraphClient.batch", () => {
  it("chunks into 20, preserves order, and retries throttled sub-requests", async () => {
    let batchCalls = 0;
    const { f } = mockFetch(async (c) => {
      batchCalls++;
      const body = JSON.parse(c.init.body as string) as { requests: { id: string }[] };
      return json({
        responses: body.requests.map((r) => ({ id: r.id, status: batchCalls === 1 && r.id === "r3" ? 429 : 204 })),
      });
    });
    const reqs = Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, method: "DELETE" as const, url: `/me/messages/${i}` }));
    const res = await client(f).batch(reqs);
    expect(res.length).toBe(25);
    expect(res.map((r) => r.id)).toEqual(reqs.map((r) => r.id));
    expect(res.every((r) => r.status === 204)).toBe(true);
    expect(batchCalls).toBe(3); // 20 + 5, then 1 retry for r3
  });
});

describe("helpers", () => {
  it("chunkArray", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("odataString escapes quotes", () => {
    expect(odataString("o'neil@x.com")).toBe("'o''neil@x.com'");
  });
});
