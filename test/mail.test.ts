import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GraphClient } from "../src/graph.js";
import { MailService } from "../src/mail.js";
import { buildMailtoUrl } from "../src/unsubscribe.js";

// The real buildMailtoUrl, wrapped so that one test can make it fail. Every other call passes through.
vi.mock("../src/unsubscribe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/unsubscribe.js")>();
  return { ...actual, buildMailtoUrl: vi.fn(actual.buildMailtoUrl) };
});

type Handler = (url: string, init: RequestInit) => unknown;

/** Fake DNS: every hostname resolves to a public address. */
const publicDns = async () => [{ address: "93.184.215.14", family: 4 }];

/** Build a MailService whose Graph calls are answered by `route`. Returns the recorded calls. */
function service(route: Handler, unsubFetch?: typeof fetch) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const body = route(url, init);
    if (body === undefined) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const graph = new GraphClient({ getToken: async () => "t", fetchImpl: f, sleep: async () => {} });
  return { mail: new MailService(graph, unsubFetch ?? f, publicDns), calls };
}

/** A `fetch` stand-in for the unsubscribe POST that fails the test if it is ever called. */
const neverPost = (async () => {
  throw new Error("unexpected one-click POST");
}) as unknown as typeof fetch;

const folders = {
  value: [
    { id: "F_INBOX".padEnd(70, "x"), displayName: "Boîte de réception", wellKnownName: "inbox", totalItemCount: 3, unreadItemCount: 1, childFolderCount: 0 },
    { id: "F_FACT".padEnd(70, "y"), displayName: "Factures", totalItemCount: 0, unreadItemCount: 0, childFolderCount: 0 },
  ],
};

const msg = (id: string, from: string, subject: string, date: string, isRead = true) => ({
  id, subject, isRead, receivedDateTime: date, from: { emailAddress: { address: from, name: from.split("@")[0] } },
});

describe("MailService folders", () => {
  it("resolves well-known names, display names and ids", async () => {
    const { mail } = service((url) => (url.includes("/me/mailFolders") ? folders : {}));
    expect(await mail.resolveFolderId(undefined)).toBe("inbox");
    expect(await mail.resolveFolderId("DeletedItems")).toBe("deleteditems");
    expect(await mail.resolveFolderId("factures")).toBe(folders.value[1]!.id);
    expect(await mail.resolveFolderId(folders.value[1]!.id)).toBe(folders.value[1]!.id);
    await expect(mail.resolveFolderId("Inexistant")).rejects.toThrow(/not found.*Factures/);
  });

  it("createFolder is idempotent", async () => {
    const { mail, calls } = service((url) => (url.includes("/me/mailFolders") ? folders : {}));
    const r = await mail.createFolder("Factures");
    expect(r.created).toBe(false);
    expect(calls.every((c) => (c.init.method ?? "GET") === "GET")).toBe(true);
  });
});

describe("MailService.sendersSummary", () => {
  it("aggregates by sender, sorts by volume and enriches top senders with headers via $batch", async () => {
    const { mail, calls } = service((url, init) => {
      if (url.endsWith("/$batch")) {
        const reqs = JSON.parse(init.body as string).requests as { id: string }[];
        return {
          responses: reqs.map((r) => ({
            id: r.id,
            status: 200,
            body: {
              id: r.id,
              internetMessageHeaders:
                r.id === "m3"
                  ? [{ name: "List-Unsubscribe", value: "<https://news.example/u>" }, { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" }]
                  : [],
            },
          })),
        };
      }
      if (url.includes("/messages")) {
        return {
          value: [
            msg("m1", "boss@work.example", "Réunion", "2025-01-01T10:00:00Z"),
            msg("m2", "news@news.example", "Promo 1", "2025-01-02T10:00:00Z", false),
            msg("m3", "news@news.example", "Promo 2", "2025-01-03T10:00:00Z", false),
          ],
        };
      }
      return folders;
    });
    const r = await mail.sendersSummary(undefined, undefined, 10);
    expect(r.scanned).toBe(3);
    expect(r.totalSenders).toBe(2);
    expect(r.senders[0]).toMatchObject({ address: "news@news.example", count: 2, unreadCount: 2, lastMessageId: "m3", lastSubject: "Promo 2" });
    expect(r.senders[0]?.unsubscribe?.oneClick).toBe(true);
    expect(r.senders[1]?.unsubscribe?.oneClick).toBe(false);

    const before = calls.length;
    await mail.sendersSummary(undefined, undefined, 10);
    expect(calls.length).toBe(before); // cached
  });
});

describe("MailService actions", () => {
  it("move uses /move with the resolved destination and reports per-id outcome", async () => {
    const { mail, calls } = service((url, init) => {
      if (url.endsWith("/$batch")) {
        const reqs = JSON.parse(init.body as string).requests as { id: string; url: string; body: { destinationId: string } }[];
        expect(reqs[0]?.url).toContain("/move");
        expect(reqs[0]?.body.destinationId).toBe(folders.value[1]!.id);
        return { responses: reqs.map((r, i) => (i === 1 ? { id: r.id, status: 404, body: { error: { code: "ErrorItemNotFound" } } } : { id: r.id, status: 201, body: { id: "NEW_" + r.id } })) };
      }
      return folders;
    });
    const out = await mail.move(["a", "b"], "Factures");
    expect(out).toEqual([{ id: "a", ok: true, newId: "NEW_a" }, { id: "b", ok: false, error: "ErrorItemNotFound" }]);
    expect(calls.some((c) => c.url.endsWith("/$batch"))).toBe(true);
  });

  it("delete moves to deleteditems by default and uses permanentDelete when asked", async () => {
    const seen: string[] = [];
    const { mail } = service((url, init) => {
      if (url.endsWith("/$batch")) {
        const reqs = JSON.parse(init.body as string).requests as { id: string; method: string; url: string }[];
        for (const r of reqs) seen.push(`${r.method} ${r.url}${(r as { body?: { destinationId?: string } }).body?.destinationId ? " -> " + (r as { body: { destinationId: string } }).body.destinationId : ""}`);
        return { responses: reqs.map((r) => ({ id: r.id, status: 204 })) };
      }
      return {};
    });
    await mail.delete(["x"], false);
    await mail.delete(["y"], true);
    expect(seen).toEqual(["POST /me/messages/x/move -> deleteditems", "POST /me/messages/y/permanentDelete"]);
  });
});

describe("MailService.unsubscribe", () => {
  const headers = (h: Record<string, string>) => Object.entries(h).map(([name, value]) => ({ name, value }));
  const message = (h: Record<string, string>) => ({ id: "m", subject: "Promo", from: { emailAddress: { address: "news@x.example" } }, internetMessageHeaders: headers(h) });

  it("one-click path posts to the https URL", async () => {
    let posted = "";
    const unsub = (async (url: string) => { posted = url; return new Response("", { status: 200 }); }) as unknown as typeof fetch;
    const { mail } = service(() => message({ "List-Unsubscribe": "<https://x.example/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }), unsub);
    const r = await mail.unsubscribe("m");
    expect(r).toMatchObject({ method: "one-click", ok: true, url: "https://x.example/u", from: "news@x.example" });
    expect(posted).toBe("https://x.example/u");
  });

  it("refuses one-click to a private address and hands over the URL and the mailto link, sending nothing", async () => {
    const { mail, calls } = service(() => message({ "List-Unsubscribe": "<https://192.168.1.1/unsub>, <mailto:stop@x.example>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }), neverPost);
    const r = await mail.unsubscribe("m");
    expect(r).toMatchObject({ method: "browser", ok: false, url: "https://192.168.1.1/unsub", mailto: "stop@x.example", mailtoUrl: "mailto:stop@x.example?subject=unsubscribe" });
    expect(r.detail).toContain("192.168.1.1");
    expect(calls.some((c) => c.url.includes("sendMail"))).toBe(false);
  });

  it("refuses one-click to a loopback address and hands the URL to the browser when there is no mailto", async () => {
    const posted: string[] = [];
    const unsub = (async (url: string) => { posted.push(url); return new Response("", { status: 200 }); }) as unknown as typeof fetch;
    const { mail } = service(() => message({ "List-Unsubscribe": "<https://[::1]/unsub>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }), unsub);
    const r = await mail.unsubscribe("m");
    expect(posted).toEqual([]);
    expect(r).toMatchObject({ method: "browser", ok: false, url: "https://[::1]/unsub" });
    expect(r.detail).toMatch(/open the url in a browser instead/i);
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

  it("https without POST header → browser", async () => {
    const { mail } = service(() => message({ "List-Unsubscribe": "<https://x.example/page>" }));
    const r = await mail.unsubscribe("m");
    expect(r).toMatchObject({ method: "browser", ok: false, url: "https://x.example/page" });
  });

  it("no header → none", async () => {
    const { mail } = service(() => message({}));
    expect((await mail.unsubscribe("m")).method).toBe("none");
  });

  describe("with a mailto subject cut inside an emoji at the 200-character limit", () => {
    const emojiSubject = encodeURIComponent("a" + "😀".repeat(150));
    const unsub = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;

    it("one-click still goes through", async () => {
      const { mail } = service(() => message({ "List-Unsubscribe": `<https://x.example/u>, <mailto:stop@x.example?subject=${emojiSubject}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }), unsub);
      expect(await mail.unsubscribe("m")).toMatchObject({ method: "one-click", ok: true, url: "https://x.example/u" });
    });

    it("the browser fallback still hands over a mailto link", async () => {
      const { mail } = service(() => message({ "List-Unsubscribe": `<https://x.example/page>, <mailto:stop@x.example?subject=${emojiSubject}>` }), neverPost);
      const r = await mail.unsubscribe("m");
      expect(r).toMatchObject({ method: "browser", ok: false, url: "https://x.example/page", mailto: "stop@x.example" });
      expect(new URLSearchParams(r.mailtoUrl?.split("?")[1]).get("subject")).toBe("a" + "😀".repeat(99));
    });
  });

  it("a mailto link that cannot be built never blocks the one-click POST", async () => {
    vi.mocked(buildMailtoUrl).mockImplementationOnce(() => {
      throw new URIError("URI malformed");
    });
    try {
      let posted = "";
      const unsub = (async (url: string) => { posted = url; return new Response("", { status: 200 }); }) as unknown as typeof fetch;
      const { mail } = service(() => message({ "List-Unsubscribe": "<https://x.example/u>, <mailto:stop@x.example>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }), unsub);
      expect(await mail.unsubscribe("m")).toMatchObject({ method: "one-click", ok: true });
      expect(posted).toBe("https://x.example/u");
    } finally {
      vi.mocked(buildMailtoUrl).mockReset(); // drops the failure if it was never used, back to the real function
    }
  });
});

it("no source file mentions sendMail or Mail.Send", () => {
  for (const f of readdirSync(new URL("../src", import.meta.url), { recursive: true }) as string[]) {
    if (!f.endsWith(".ts")) continue;
    const text = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    expect(text, f).not.toMatch(/sendMail|Mail\.Send/);
  }
});
