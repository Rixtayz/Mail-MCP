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

  it("maps 404 to an actionable error", async () => {
    const { f } = mockFetch(() => json({ error: { code: "ErrorItemNotFound", message: "nope" } }, 404));
    await expect(client(f).get("/me/messages/x")).rejects.toThrow(/Introuvable \(404\)/);
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
