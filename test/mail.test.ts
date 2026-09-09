import { describe, expect, it } from "vitest";
import { GraphClient } from "../src/graph.js";
import { MailService } from "../src/mail.js";

type Handler = (url: string, init: RequestInit) => unknown;

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
  return { mail: new MailService(graph, unsubFetch ?? f), calls };
}

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

  it("mailto path sends a mail through Graph without saving to Sent Items", async () => {
    let sent: unknown;
    const { mail } = service((url, init) => {
      if (url.endsWith("/me/sendMail")) { sent = JSON.parse(init.body as string); return undefined; }
      return message({ "List-Unsubscribe": "<mailto:stop@x.example?subject=Unsub%20me>" });
    });
    const r = await mail.unsubscribe("m");
    expect(r).toMatchObject({ method: "mailto", ok: true, mailto: "stop@x.example" });
    expect(sent).toMatchObject({ saveToSentItems: false, message: { subject: "Unsub me", toRecipients: [{ emailAddress: { address: "stop@x.example" } }] } });
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
});
