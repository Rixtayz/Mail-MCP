import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GraphClient } from "../src/graph.js";
import { MailService, unsubscribeOptions } from "../src/mail.js";
import { buildMailtoUrl, parseListUnsubscribe, type HostResolver, type UnsubscribeNetwork } from "../src/unsubscribe.js";
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
        const reqs = JSON.parse(init.body as string).requests as { id: string; url: string }[];
        return {
          responses: reqs.map((r) => ({
            id: r.id,
            status: 200,
            body: {
              id: r.id,
              internetMessageHeaders:
                r.url.startsWith("/me/messages/m3?")
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
        return {
          responses: reqs.map((r, i) =>
            i === 1 ? { id: r.id, status: 404, body: { error: { code: "ErrorItemNotFound" } } } : { id: r.id, status: 201, body: { id: "NEW_" + r.url.split("/")[3] } },
          ),
        };
      }
      return folders;
    });
    const out = await mail.move(["a", "b"], "Factures");
    expect(out).toEqual([{ id: "a", ok: true, newId: "NEW_a" }, { id: "b", ok: false, error: "ErrorItemNotFound" }]);
    expect(calls.some((c) => c.url.endsWith("/$batch"))).toBe(true);
  });

  it("delete only ever moves to deleteditems; permanentDelete is a separate method", async () => {
    const seen: string[] = [];
    const { mail } = service((url, init) => {
      if (url.endsWith("/$batch")) {
        const reqs = JSON.parse(init.body as string).requests as { id: string; method: string; url: string }[];
        for (const r of reqs) seen.push(`${r.method} ${r.url}${(r as { body?: { destinationId?: string } }).body?.destinationId ? " -> " + (r as { body: { destinationId: string } }).body.destinationId : ""}`);
        return { responses: reqs.map((r) => ({ id: r.id, status: 204 })) };
      }
      return {};
    });
    await mail.delete(["x"]);
    // A caller still passing the old `permanent` flag gets a soft delete, never a purge.
    await (mail.delete as (...args: unknown[]) => Promise<unknown>)(["z"], true);
    await mail.permanentDelete(["y"]);
    expect(seen).toEqual(["POST /me/messages/x/move -> deleteditems", "POST /me/messages/z/move -> deleteditems", "POST /me/messages/y/permanentDelete"]);
  });
});

// Real message ids from the Microsoft Graph documentation (message: move, Get message).
const DOC_ID_A = "AAMkADhAAATs28OAAA=";
const DOC_ID_B = "AAMkADhAAAW-VPeAAA=";
const INVALID_ID = "Refused an id that is not one Microsoft Graph gave: pass ids exactly as mail_search, mail_senders_summary or mail_list_folders returned them.";

describe("MailService batches", () => {
  /** A $batch endpoint that records the sub-requests it receives and answers each with `status`. */
  function batchService(status: number) {
    const sent: { id: string; method: string; url: string }[] = [];
    const s = service((url, init) => {
      if (url.endsWith("/$batch")) {
        const reqs = JSON.parse(init.body as string).requests as { id: string; method: string; url: string }[];
        sent.push(...reqs);
        return { responses: reqs.map((r) => ({ id: r.id, status, ...(status === 201 ? { body: { id: `NEW_${r.url.split("/")[3]}` } } : {}) })) };
      }
      return folders;
    });
    return { ...s, sent };
  }

  it.each([
    ["move", (mail: MailService, ids: string[]) => mail.move(ids, "Factures"), "move", 201],
    ["delete", (mail: MailService, ids: string[]) => mail.delete(ids), "move", 201],
    ["permanentDelete", (mail: MailService, ids: string[]) => mail.permanentDelete(ids), "permanentDelete", 204],
  ] as const)("%s acts once on each distinct id, under index request ids, and answers under the message ids", async (_name, act, action, status) => {
    const { mail, sent } = batchService(status);
    const out = await act(mail, [DOC_ID_A, DOC_ID_B, DOC_ID_A, DOC_ID_B, DOC_ID_A]);
    expect(sent.map((r) => [r.id, r.url])).toEqual([
      ["0", `/me/messages/AAMkADhAAATs28OAAA%3D/${action}`],
      ["1", `/me/messages/AAMkADhAAAW-VPeAAA%3D/${action}`],
    ]);
    expect(out.map((o) => o.id)).toEqual([DOC_ID_A, DOC_ID_B]);
    expect(out.every((o) => o.ok)).toBe(true);
    if (status === 201) expect(out.map((o) => o.newId)).toEqual(["NEW_AAMkADhAAATs28OAAA%3D", "NEW_AAMkADhAAAW-VPeAAA%3D"]);
  });

  it("sendersSummary reads each latest message's headers under index request ids", async () => {
    const sent: { id: string; url: string }[] = [];
    const { mail } = service((url, init) => {
      if (url.endsWith("/$batch")) {
        const reqs = JSON.parse(init.body as string).requests as { id: string; url: string }[];
        sent.push(...reqs);
        return { responses: reqs.map((r) => ({ id: r.id, status: 200, body: { internetMessageHeaders: [{ name: "List-Unsubscribe", value: "<mailto:stop@x.example>" }] } })) };
      }
      if (url.includes("/messages")) return { value: [msg(DOC_ID_A, "a@x.example", "s", "2025-01-01T00:00:00Z"), msg(DOC_ID_B, "b@x.example", "s", "2025-01-02T00:00:00Z")] };
      return folders;
    });
    const r = await mail.sendersSummary(undefined, undefined, 10);
    expect(sent.map((s) => s.id)).toEqual(["0", "1"]);
    expect(r.senders.map((s) => [s.lastMessageId, s.unsubscribe?.mailto])).toEqual([
      [DOC_ID_B, "stop@x.example"],
      [DOC_ID_A, "stop@x.example"],
    ]);
  });
});

describe("MailService keeps every id inside its own path segment", () => {
  it.each([".", "..", ""])("refuses the message id %j before any request", async (id) => {
    const { mail, calls } = service(() => folders);
    await expect(mail.getMessage(id)).rejects.toThrow(INVALID_ID);
    await expect(mail.unsubscribe(id)).rejects.toThrow(INVALID_ID);
    await expect(mail.move([DOC_ID_A, id], "inbox")).rejects.toThrow(INVALID_ID);
    await expect(mail.delete([id])).rejects.toThrow(INVALID_ID);
    await expect(mail.permanentDelete([id])).rejects.toThrow(INVALID_ID);
    expect(calls).toEqual([]);
  });

  it("encodes a message id holding / + = so that it names that one message", async () => {
    const { mail, calls } = service(() => ({ id: "x", internetMessageHeaders: [] }));
    await mail.getMessage("AAMkADhAAAW/VPeAAA+=");
    await mail.unsubscribe("AAMkADhAAAW/VPeAAA+=");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/v1.0/me/messages/AAMkADhAAAW%2FVPeAAA%2B%3D",
      "/v1.0/me/messages/AAMkADhAAAW%2FVPeAAA%2B%3D",
    ]);
  });

  // Folder ids come from Graph. Whatever they hold, each stays one segment of the path.
  const parent = "AAMkADhAAAAAAEKAAA/+x=";
  const child = "AAMkADcbAAAAAAEJAAA=";
  const tree = (url: string) =>
    url.includes("/childFolders")
      ? { value: [{ id: child, displayName: "2025", parentFolderId: parent, childFolderCount: 0 }] }
      : url.includes("/messages")
        ? { value: [] }
        : { value: [{ id: parent, displayName: "Projects", childFolderCount: 1 }] };

  it("encodes folder ids wherever they enter a path", async () => {
    const { mail, calls } = service((url, init) => ((init.method ?? "GET") === "POST" ? { id: "NEW", displayName: "Sub" } : tree(url)));
    await mail.listFolders();
    await mail.search({ folder: "Projects", limit: 5 });
    await mail.sendersSummary("Projects", undefined, 5);
    await mail.bulkBySender({ from: "news@x.example", folder: "Projects", action: "delete" });
    await mail.createFolder("Sub", "Projects");
    const paths = calls.map((c) => `${c.init.method ?? "GET"} ${new URL(c.url).pathname}`);
    expect(new Set(paths)).toEqual(
      new Set([
        "GET /v1.0/me/mailFolders",
        "GET /v1.0/me/mailFolders/AAMkADhAAAAAAEKAAA%2F%2Bx%3D/childFolders",
        "GET /v1.0/me/mailFolders/AAMkADhAAAAAAEKAAA%2F%2Bx%3D/messages",
        "POST /v1.0/me/mailFolders/AAMkADhAAAAAAEKAAA%2F%2Bx%3D/childFolders",
      ]),
    );
  });

  it("refuses a folder whose id would name another resource", async () => {
    const { mail, calls } = service((url) =>
      url.includes("/messages") ? { value: [] } : { value: [{ id: "..", displayName: "Weird", childFolderCount: 0 }] },
    );
    await expect(mail.search({ folder: "Weird", limit: 5 })).rejects.toThrow(INVALID_ID);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/v1.0/me/mailFolders"]);
  });

  it.each([".", "..", "/", "A".repeat(70) + "/..", "A".repeat(70) + "/x", "../" + "A".repeat(70)])(
    "never uses %j as a folder id: it is looked up by name, and not found",
    async (value) => {
      const { mail, calls } = service(() => folders);
      await expect(mail.resolveFolderId(value)).rejects.toThrow(/not found/);
      await expect(mail.search({ folder: value, limit: 5 })).rejects.toThrow(/not found/);
      expect(calls.every((c) => new URL(c.url).pathname === "/v1.0/me/mailFolders")).toBe(true);
    },
  );
});

describe("MailService.sendersSummary scan limit", () => {
  /** A folder of `count` messages from three senders, in pages of 1,000. `pages` records each page read. */
  function folderOf(count: number) {
    const pages: number[] = [];
    const s = service((url, init) => {
      if (url.endsWith("/$batch")) {
        const reqs = JSON.parse(init.body as string).requests as { id: string }[];
        return { responses: reqs.map((r) => ({ id: r.id, status: 200, body: { internetMessageHeaders: [] } })) };
      }
      if (url.includes("/messages")) {
        const page = Number(new URL(url).searchParams.get("page") ?? "0");
        pages.push(page);
        const value = Array.from({ length: Math.max(0, Math.min(1000, count - page * 1000)) }, (_, i) =>
          msg(`m${page * 1000 + i}`, `s${i % 3}@x.example`, "s", "2025-01-01T00:00:00Z"),
        );
        const more = (page + 1) * 1000 < count;
        return { value, ...(more ? { "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?page=${page + 1}` } : {}) };
      }
      return folders;
    });
    return { ...s, pages };
  }

  it("stops after scanning 50,000 messages and says the summary is partial, also from the cache", async () => {
    const { mail, pages } = folderOf(120_000);
    const r = await mail.sendersSummary(undefined, undefined, 10);
    expect(r).toMatchObject({ scanned: 50_000, partial: true, totalSenders: 3 });
    expect(r.senders.reduce((n, s) => n + s.count, 0)).toBe(50_000);
    expect(pages.length).toBeLessThanOrEqual(51);
    expect(await mail.sendersSummary(undefined, undefined, 10)).toMatchObject({ scanned: 50_000, partial: true });
    expect(pages.length).toBeLessThanOrEqual(51);
  });

  it("is complete at exactly 50,000 messages", async () => {
    const { mail } = folderOf(50_000);
    expect(await mail.sendersSummary(undefined, undefined, 10)).toMatchObject({ scanned: 50_000, partial: false });
  });

  it("counts every message read, with or without a sender, also from the cache", async () => {
    const { mail } = service((url, init) => {
      if (url.endsWith("/$batch")) {
        const reqs = JSON.parse(init.body as string).requests as { id: string }[];
        return { responses: reqs.map((r) => ({ id: r.id, status: 200, body: { internetMessageHeaders: [] } })) };
      }
      if (url.includes("/messages")) return { value: [msg("m1", "a@x.example", "s", "2025-01-01T00:00:00Z"), { id: "m2", subject: "no sender" }] };
      return folders;
    });
    expect(await mail.sendersSummary(undefined, undefined, 10)).toMatchObject({ scanned: 2, partial: false, totalSenders: 1 });
    expect(await mail.sendersSummary(undefined, undefined, 10)).toMatchObject({ scanned: 2, partial: false, totalSenders: 1 });
  });
});

describe("MailService.bulkBySender", () => {
  const fromSender = () =>
    service((url, init) => {
      if (url.endsWith("/$batch")) {
        const reqs = JSON.parse(init.body as string).requests as { id: string }[];
        return { responses: reqs.map((r) => ({ id: r.id, status: 201, body: { id: `NEW_${r.id}` } })) };
      }
      return { value: [{ id: "m1" }, { id: "m2" }] };
    });

  it("is a dry run when called without dryRun: counts and makes no POST", async () => {
    const { mail, calls } = fromSender();
    const r = await mail.bulkBySender({ from: "news@x.example", action: "delete" });
    expect(r).toEqual({ matched: 2, capped: false, dryRun: true, outcomes: [] });
    expect(calls.filter((c) => (c.init.method ?? "GET") !== "GET")).toEqual([]);
  });

  it("acts only on an explicit dryRun: false", async () => {
    const { mail, calls } = fromSender();
    const r = await mail.bulkBySender({ from: "news@x.example", action: "delete", dryRun: false });
    expect(r).toMatchObject({ matched: 2, capped: false, dryRun: false });
    expect(r.outcomes).toHaveLength(2);
    expect(calls.filter((c) => c.init.method === "POST").map((c) => c.url)).toEqual(["https://graph.microsoft.com/v1.0/$batch"]);
  });
});

describe("unsubscribeOptions", () => {
  const headers = (h: Record<string, string>) => Object.entries(h).map(([name, value]) => ({ name, value }));
  const oneClick = { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };

  it.each([
    ["a one-click https link", { "List-Unsubscribe": "<https://x.example/u>", ...oneClick }, "one-click"],
    ["an https link without one-click", { "List-Unsubscribe": "<https://x.example/u>" }, "browser"],
    ["an https link and a mailto", { "List-Unsubscribe": "<https://x.example/u>, <mailto:stop@x.example>" }, "browser"],
    ["a mailto only", { "List-Unsubscribe": "<mailto:stop@x.example>" }, "mailto"],
    ["no header", {}, "none"],
    ["a plain http link and a mailto", { "List-Unsubscribe": "<http://x.example/u>, <mailto:stop@x.example>" }, "mailto"],
    ["a plain http link alone", { "List-Unsubscribe": "<http://x.example/u>", ...oneClick }, "blocked"],
    ["a one-click link to a private address, with a mailto", { "List-Unsubscribe": "<https://192.168.1.1/u>, <mailto:stop@x.example>", ...oneClick }, "blocked"],
    ["a link to [::1]", { "List-Unsubscribe": "<https://[::1]/u>" }, "blocked"],
    ["a NAT64 link carrying a private address", { "List-Unsubscribe": "<https://[64:ff9b::a00:1]/u>", ...oneClick }, "blocked"],
    ["a one-click link to localhost, with a mailto", { "List-Unsubscribe": "<https://localhost:8443/u>, <mailto:stop@x.example>", ...oneClick }, "blocked"],
    ["a link to a name under .localhost", { "List-Unsubscribe": "<https://shop.localhost/u>" }, "blocked"],
    ["a plain http link to a private address, with a mailto", { "List-Unsubscribe": "<http://10.0.0.1/u>, <mailto:stop@x.example>" }, "blocked"],
    ["a link that is not a valid URL, with a mailto", { "List-Unsubscribe": "<https://[nothex]/u>, <mailto:stop@x.example>", ...oneClick }, "blocked"],
    ["a one-click link to a public address", { "List-Unsubscribe": "<https://93.184.215.14/u>", ...oneClick }, "one-click"],
  ])("labels %s with the method mail_unsubscribe uses, without a lookup", async (_label, h, expected) => {
    const lookups: string[] = [];
    const { mail } = service(
      () => ({ id: "m", subject: "Promo", from: { emailAddress: { address: "news@x.example" } }, internetMessageHeaders: headers(h) }),
      {
        resolveHost: async (host) => {
          lookups.push(host);
          return publicDns(host);
        },
      },
    );
    const options = unsubscribeOptions(parseListUnsubscribe(headers(h)));
    expect(lookups).toEqual([]);
    expect(options.method).toBe(expected);
    expect((await mail.unsubscribe("m")).method).toBe(expected);
  });

  it("leaves out every link and address when the link is blocked", () => {
    const info = parseListUnsubscribe(headers({ "List-Unsubscribe": "<https://192.168.1.1/u>, <mailto:stop@x.example?subject=Stop>", ...oneClick }));
    expect(unsubscribeOptions(info)).toEqual({ method: "blocked", oneClick: false, detail: LOCAL_LINK });
  });

  it("says why a link that is not a valid URL is blocked", () => {
    expect(unsubscribeOptions(parseListUnsubscribe(headers({ "List-Unsubscribe": "<https://[nothex]/u>" })))).toEqual({
      method: "blocked",
      oneClick: false,
      detail: "This unsubscribe link could not be checked (the URL is not valid), so it was not opened.",
    });
  });

  it("keeps the mailto subject and body, but not a plain http link, when http falls back to email", () => {
    const info = parseListUnsubscribe(headers({ "List-Unsubscribe": "<http://x.example/u>, <mailto:stop@x.example?subject=Stop&body=Please>" }));
    expect(unsubscribeOptions(info)).toEqual({
      method: "mailto",
      oneClick: false,
      mailto: "stop@x.example",
      mailtoSubject: "Stop",
      mailtoBody: "Please",
      detail: `${HTTP_LINK} The sender also accepts unsubscribe requests by email.`,
    });
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
    ["a private address, with a mailto", "<http://192.168.1.1/admin>, <mailto:stop@x.example>"],
    ["localhost, with a mailto", "<http://localhost:8080/x>, <mailto:stop@x.example>"],
    ["a private address, alone", "<http://192.168.1.1/admin>"],
  ])("blocks a plain http link to %s as a local-network link, with no mailto", async (_label, header) => {
    const { mail, posts } = service(() => message({ "List-Unsubscribe": header }));
    expect(await mail.unsubscribe("m")).toEqual(blocked(LOCAL_LINK));
    expect(posts.attempts).toEqual([]);
  });

  it("blocks a plain http link whose name resolves to the local network, with no mailto", async () => {
    const dns: HostResolver = async () => [{ address: "10.0.0.1", family: 4 }];
    const { mail } = service(() => message({ "List-Unsubscribe": "<http://router.example/admin>, <mailto:stop@x.example>" }), { resolveHost: dns });
    expect(await mail.unsubscribe("m")).toEqual(blocked(LOCAL_LINK));
  });

  it("blocks a plain http link whose host cannot be checked, with no mailto", async () => {
    const dns: HostResolver = async () => {
      throw new Error("getaddrinfo ENOTFOUND nowhere.example");
    };
    const { mail } = service(() => message({ "List-Unsubscribe": "<http://nowhere.example/u>, <mailto:stop@x.example>" }), { resolveHost: dns });
    expect(await mail.unsubscribe("m")).toEqual(
      blocked("This unsubscribe link could not be checked (nowhere.example could not be resolved: getaddrinfo ENOTFOUND nowhere.example), so it was not opened."),
    );
  });

  it("checks the host of a plain http link on a public host before falling back to the mailto link", async () => {
    const asked: string[] = [];
    const dns: HostResolver = async (host) => {
      asked.push(host);
      return publicDns(host);
    };
    const { mail } = service(() => message({ "List-Unsubscribe": "<http://news.example/u>, <mailto:stop@x.example>" }), { resolveHost: dns });
    expect(await mail.unsubscribe("m")).toMatchObject({ method: "mailto", mailtoUrl: "mailto:stop@x.example?subject=unsubscribe" });
    expect(asked).toEqual(["news.example"]);
  });

  it.each([
    ["without", {}],
    ["with", { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }],
  ])("blocks a plain http link with no mailto %s List-Unsubscribe-Post", async (_label, post) => {
    const { mail, posts } = service(() => message({ "List-Unsubscribe": "<http://x.example/u>", ...post }));
    expect(await mail.unsubscribe("m")).toEqual(blocked(HTTP_LINK));
    expect(posts.attempts).toEqual([]);
  });

  it.each([
    ["without", {}],
    ["with", { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }],
  ])("skips a plain http link for the mailto link %s List-Unsubscribe-Post", async (_label, post) => {
    const { mail, posts } = service(() => message({ "List-Unsubscribe": "<http://x.example/u>, <mailto:stop@x.example>", ...post }));
    const r = await mail.unsubscribe("m");
    expect(r).toEqual({
      method: "mailto",
      ok: false,
      mailto: "stop@x.example",
      mailtoUrl: "mailto:stop@x.example?subject=unsubscribe",
      detail:
        "This unsubscribe link is not encrypted (http) and was not opened. The sender also accepts unsubscribe requests by email. Mail-MCP never sends email: give the user this link. It opens a pre-filled message in their own mail app, and they press Send.",
      from: "news@x.example",
      subject: "Promo",
    });
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

describe("MailService cleans what comes from a message", () => {
  it("getMessage: body, subject, sender, recipients (at most 50) and the mailto subject and body", async () => {
    const toRecipients = Array.from({ length: 60 }, (_, i) => ({ emailAddress: { name: `R${i}`, address: `r${i}@x.example\u202E` } }));
    const { mail } = service(() => ({
      id: "m",
      subject: "Hello\r\nBcc: you\u{E0041}",
      from: { emailAddress: { name: "News\u200B", address: "news@x.example" } },
      toRecipients,
      body: { contentType: "text", content: "Line one\u202E\r\nLine two\u{E0049}\u001b[2J" },
      internetMessageHeaders: [{ name: "List-Unsubscribe", value: "<mailto:stop@x.example?subject=Stop%E2%80%AE%F3%A0%81%81&body=Ple%E2%80%8Base%EF%B8%8F>" }],
    }));
    const r = await mail.getMessage("m");
    expect(r.summary.subject).toBe("Hello Bcc: you");
    expect(r.summary.fromName).toBe("News");
    expect(r.body).toBe("Line one\nLine two[2J");
    expect(r.to).toEqual(Array.from({ length: 50 }, (_, i) => `r${i}@x.example`));
    expect(r.toTotal).toBe(60);
    expect(r.unsubscribe.mailtoSubject).toBe("Stop");
    expect(r.unsubscribe.mailtoBody).toBe("Please");
  });

  it("sendersSummary: sender name and address, latest subject", async () => {
    const { mail } = service((url, init) => {
      if (url.endsWith("/$batch")) {
        const reqs = JSON.parse(init.body as string).requests as { id: string }[];
        return { responses: reqs.map((r) => ({ id: r.id, status: 200, body: { id: r.id, internetMessageHeaders: [] } })) };
      }
      if (url.includes("/messages")) {
        return {
          value: [
            {
              id: "m1",
              subject: "Sale\nends\u202E today",
              isRead: true,
              receivedDateTime: "2025-01-01T10:00:00Z",
              from: { emailAddress: { address: "News@X.example\u200B", name: "X\u{E0041} News\r\n" + "n".repeat(300) } },
            },
          ],
        };
      }
      return folders;
    });
    const r = await mail.sendersSummary(undefined, undefined, 10);
    expect(r.senders[0]).toMatchObject({
      address: "news@x.example",
      domain: "x.example",
      name: ("X News " + "n".repeat(300)).slice(0, 200),
      lastSubject: "Sale ends today",
    });
  });

  it("listFolders: folder names and paths, which then resolve", async () => {
    const parent = "P".padEnd(70, "p");
    const child = "C".padEnd(70, "c");
    const { mail } = service((url) =>
      url.includes("/childFolders")
        ? { value: [{ id: child, displayName: "20\u202E25\r\n", parentFolderId: parent, childFolderCount: 0 }] }
        : { value: [{ id: parent, displayName: "News\u200Bletters", childFolderCount: 1 }] },
    );
    const list = await mail.listFolders();
    expect(list.map((f) => [f.name, f.path])).toEqual([
      ["Newsletters", "Newsletters"],
      ["2025", "Newsletters/2025"],
    ]);
    expect(await mail.resolveFolderId("Newsletters/2025")).toBe(child);
  });

  it("unsubscribe: sender address and subject", async () => {
    const { mail } = service(() => ({ id: "m", subject: "Promo\r\n\u202Eout", from: { emailAddress: { address: "news@x.example\u200B" } }, internetMessageHeaders: [] }));
    expect(await mail.unsubscribe("m")).toMatchObject({ method: "none", from: "news@x.example", subject: "Promo out" });
  });
});

it("no source file mentions sendMail or Mail.Send", () => {
  for (const f of readdirSync(new URL("../src", import.meta.url), { recursive: true }) as string[]) {
    if (!f.endsWith(".ts")) continue;
    const text = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    expect(text, f).not.toMatch(/sendMail|Mail\.Send/);
  }
});
