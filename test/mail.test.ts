import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GraphClient } from "../src/graph.js";
import { MailService } from "../src/mail.js";
import { buildMailtoUrl, type HostResolver, type UnsubscribeNetwork } from "../src/unsubscribe.js";
import { fakeRequest } from "./fake-request.js";

// The real buildMailtoUrl, wrapped so that one test can make it fail. Every other call passes through.
vi.mock("../src/unsubscribe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/unsubscribe.js")>();
  return { ...actual, buildMailtoUrl: vi.fn(actual.buildMailtoUrl) };
});

// A test that falls back to the real resolver fails instead of reaching the network.
vi.mock("node:dns/promises", () => ({
  lookup: async () => {
    throw new Error("a test used the real DNS resolver");
  },
}));

type Handler = (url: string, init: RequestInit) => unknown;

/** Fake DNS: every hostname resolves to a public address. */
const publicDns: HostResolver = async () => [{ address: "93.184.215.14", family: 4 }];

/**
 * Build a MailService whose Graph calls are answered by `route`. Returns the recorded Graph calls, and
 * `posts`, the default stand-in for the one-click POST, which answers 200 and records every request.
 */
function service(route: Handler, net: UnsubscribeNetwork = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const body = route(url, init);
    if (body === undefined) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const graph = new GraphClient({ getToken: async () => "t", fetchImpl: f, sleep: async () => {} });
  const posts = fakeRequest(200);
  return { mail: new MailService(graph, { resolveHost: publicDns, request: posts.request, ...net }), calls, posts };
}

const LOCAL_LINK =
  "This unsubscribe link points to this computer or the local network, which a real newsletter never does. It was not opened. Treat this message as suspicious.";
const HTTP_LINK = "This unsubscribe link is not encrypted (http) and was not opened.";

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

describe("MailService.getMessage", () => {
  it("returns the raw mailto subject and body without control characters, capped at 200 and 1000 characters", async () => {
    const subject = encodeURIComponent("Stop\r\n" + "s".repeat(300));
    const body = encodeURIComponent("\u001b[2J" + "b".repeat(2000));
    const { mail } = service(() => ({
      id: "m",
      subject: "Promo",
      from: { emailAddress: { address: "news@x.example" } },
      body: { contentType: "text", content: "hi" },
      internetMessageHeaders: [{ name: "List-Unsubscribe", value: `<mailto:stop@x.example?subject=${subject}&body=${body}>` }],
    }));
    const r = await mail.getMessage("m");
    expect(r.unsubscribe.mailtoSubject).toBe("Stop" + "s".repeat(196));
    expect(r.unsubscribe.mailtoBody).toBe("[2J" + "b".repeat(997));
  });
});

describe("MailService.unsubscribe", () => {
  const headers = (h: Record<string, string>) => Object.entries(h).map(([name, value]) => ({ name, value }));
  const message = (h: Record<string, string>) => ({ id: "m", subject: "Promo", from: { emailAddress: { address: "news@x.example" } }, internetMessageHeaders: headers(h) });
  const oneClick = "List-Unsubscribe=One-Click";
  const blocked = (detail: string) => ({ method: "blocked", ok: false, detail, from: "news@x.example", subject: "Promo" });

  it("one-click path posts to the https URL", async () => {
    const { mail, posts } = service(() => message({ "List-Unsubscribe": "<https://x.example/u>", "List-Unsubscribe-Post": oneClick }));
    const r = await mail.unsubscribe("m");
    expect(r).toMatchObject({ method: "one-click", ok: true, url: "https://x.example/u", from: "news@x.example" });
    expect(posts.sent.map((s) => `${s.options.hostname}${s.options.path}`)).toEqual(["x.example/u"]);
    expect(posts.sent[0]?.connectedTo).toEqual(["93.184.215.14"]);
  });

  it("blocks a one-click link to a private address: no URL, no mailto link, nothing sent", async () => {
    const { mail, calls, posts } = service(() => message({ "List-Unsubscribe": "<https://192.168.1.1/unsub>, <mailto:stop@x.example>", "List-Unsubscribe-Post": oneClick }));
    const r = await mail.unsubscribe("m");
    expect(r).toEqual(blocked(LOCAL_LINK));
    expect(posts.attempts).toEqual([]);
    expect(calls.some((c) => c.url.includes("sendMail"))).toBe(false);
  });

  it("blocks a one-click link to a loopback address", async () => {
    const { mail, posts } = service(() => message({ "List-Unsubscribe": "<https://[::1]/unsub>", "List-Unsubscribe-Post": oneClick }));
    expect(await mail.unsubscribe("m")).toEqual(blocked(LOCAL_LINK));
    expect(posts.attempts).toEqual([]);
  });

  it("blocks a one-click link whose name resolves to the local network", async () => {
    const dns: HostResolver = async () => [{ address: "192.168.1.1", family: 4 }];
    const { mail, posts } = service(
      () => message({ "List-Unsubscribe": "<https://router.example/reboot>, <mailto:stop@x.example>", "List-Unsubscribe-Post": oneClick }),
      { resolveHost: dns },
    );
    expect(await mail.unsubscribe("m")).toEqual(blocked(LOCAL_LINK));
    expect(posts.attempts).toEqual([]);
  });

  it("blocks a one-click link whose name rebinds to the local network for the connection", async () => {
    const answers = [[{ address: "93.184.215.14" }], [{ address: "10.0.0.7" }]];
    const dns: HostResolver = async () => answers.shift() ?? [];
    const { mail, posts } = service(() => message({ "List-Unsubscribe": "<https://rebind.example/u>", "List-Unsubscribe-Post": oneClick }), { resolveHost: dns });
    expect(await mail.unsubscribe("m")).toEqual(blocked(LOCAL_LINK));
    expect(posts.sent).toEqual([]);
  });

  it("blocks a link offered without one-click when it points to the local network", async () => {
    const { mail, posts } = service(() => message({ "List-Unsubscribe": "<https://10.0.0.1/unsub>, <mailto:stop@x.example>" }));
    expect(await mail.unsubscribe("m")).toEqual(blocked(LOCAL_LINK));
    expect(posts.attempts).toEqual([]);
  });

  it("blocks a link offered without one-click when its name resolves to this computer", async () => {
    const asked: string[] = [];
    const dns: HostResolver = async (host) => {
      asked.push(host);
      return [{ address: "127.0.0.1", family: 4 }];
    };
    const { mail } = service(() => message({ "List-Unsubscribe": "<https://router.example/admin>" }), { resolveHost: dns });
    expect(await mail.unsubscribe("m")).toEqual(blocked(LOCAL_LINK));
    expect(asked).toEqual(["router.example"]);
  });

  it.each([
    ["without", {}],
    ["with", { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }],
  ])("blocks a plain http link %s List-Unsubscribe-Post", async (_label, post) => {
    const { mail, posts } = service(() => message({ "List-Unsubscribe": "<http://x.example/u>, <mailto:stop@x.example>", ...post }));
    expect(await mail.unsubscribe("m")).toEqual(blocked(HTTP_LINK));
    expect(posts.attempts).toEqual([]);
  });

  it("uses the https link when an http one is listed first", async () => {
    const { mail } = service(() => message({ "List-Unsubscribe": "<http://x.example/u>, <https://x.example/s>" }));
    expect(await mail.unsubscribe("m")).toMatchObject({ method: "browser", ok: false, url: "https://x.example/s" });
  });

  it("does not hand over a link whose host cannot be checked", async () => {
    const dns: HostResolver = async () => {
      throw new Error("getaddrinfo ENOTFOUND nowhere.example");
    };
    const { mail } = service(() => message({ "List-Unsubscribe": "<https://nowhere.example/u>, <mailto:stop@x.example>" }), { resolveHost: dns });
    expect(await mail.unsubscribe("m")).toEqual(
      blocked("This unsubscribe link could not be checked (nowhere.example could not be resolved: getaddrinfo ENOTFOUND nowhere.example), so it was not opened."),
    );
  });

  it("hands a public link to the browser, with the mailto link, when the one-click POST is rejected", async () => {
    const rejecting = fakeRequest(500);
    const { mail } = service(
      () => message({ "List-Unsubscribe": "<https://x.example/u>, <mailto:stop@x.example>", "List-Unsubscribe-Post": oneClick }),
      { request: rejecting.request },
    );
    const r = await mail.unsubscribe("m");
    expect(r).toMatchObject({ method: "browser", ok: false, url: "https://x.example/u", mailto: "stop@x.example", mailtoUrl: "mailto:stop@x.example?subject=unsubscribe" });
    expect(r.detail).toContain("HTTP 500");
    expect(rejecting.sent).toHaveLength(1);
  });

  it("mailto-only header returns a link for the user and sends nothing", async () => {
    const { mail, calls, posts } = service(() => message({ "List-Unsubscribe": "<mailto:stop@x.example?subject=Unsub%20me>" }));
    const r = await mail.unsubscribe("m");
    expect(r).toMatchObject({ method: "mailto", ok: false, mailto: "stop@x.example", mailtoUrl: "mailto:stop@x.example?subject=Unsub%20me" });
    expect(r.detail).toMatch(/never sends email/i);
    expect(calls.every((c) => (c.init.method ?? "GET") === "GET")).toBe(true);
    expect(posts.attempts).toEqual([]);
  });

  it("https and mailto without one-click returns both", async () => {
    const { mail, posts } = service(() => message({ "List-Unsubscribe": "<https://x.example/page>, <mailto:stop@x.example>" }));
    expect(await mail.unsubscribe("m")).toMatchObject({ method: "browser", ok: false, url: "https://x.example/page", mailtoUrl: "mailto:stop@x.example?subject=unsubscribe" });
    expect(posts.attempts).toEqual([]);
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

    it("one-click still goes through", async () => {
      const { mail } = service(() => message({ "List-Unsubscribe": `<https://x.example/u>, <mailto:stop@x.example?subject=${emojiSubject}>`, "List-Unsubscribe-Post": oneClick }));
      expect(await mail.unsubscribe("m")).toMatchObject({ method: "one-click", ok: true, url: "https://x.example/u" });
    });

    it("the browser fallback still hands over a mailto link", async () => {
      const { mail, posts } = service(() => message({ "List-Unsubscribe": `<https://x.example/page>, <mailto:stop@x.example?subject=${emojiSubject}>` }));
      const r = await mail.unsubscribe("m");
      expect(r).toMatchObject({ method: "browser", ok: false, url: "https://x.example/page", mailto: "stop@x.example" });
      expect(new URLSearchParams(r.mailtoUrl?.split("?")[1]).get("subject")).toBe("a" + "😀".repeat(99));
      expect(posts.attempts).toEqual([]);
    });
  });

  it("a mailto link that cannot be built never blocks the one-click POST", async () => {
    vi.mocked(buildMailtoUrl).mockImplementationOnce(() => {
      throw new URIError("URI malformed");
    });
    try {
      const { mail, posts } = service(() => message({ "List-Unsubscribe": "<https://x.example/u>, <mailto:stop@x.example>", "List-Unsubscribe-Post": oneClick }));
      expect(await mail.unsubscribe("m")).toMatchObject({ method: "one-click", ok: true });
      expect(posts.sent.map((s) => `${s.options.hostname}${s.options.path}`)).toEqual(["x.example/u"]);
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
