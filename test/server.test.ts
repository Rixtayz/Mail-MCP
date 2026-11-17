import { readFileSync } from "node:fs";
import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/constants.js";
import { GraphClient } from "../src/graph.js";
import { MailService as MailServiceImpl, type MailService } from "../src/mail.js";
import { buildServer } from "../src/server.js";
import type { SessionService } from "../src/tools/session.js";
import type { UnsubscribeInfo } from "../src/types.js";

describe("VERSION", () => {
  it("matches package.json, so serverInfo and --version never drift from the release", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

/** A server on an in-memory transport. `mail` defaults to a stub whose tools are only listed, never called. */
async function connect(session: SessionService, mail = {} as MailService) {
  const server = buildServer(mail, session);
  const [client, serverEnd] = InMemoryTransport.createLinkedPair();
  const pending = new Map<number, (m: JSONRPCMessage) => void>();
  client.onmessage = (m) => {
    if ("id" in m && typeof m.id === "number") pending.get(m.id)?.(m);
  };
  await server.connect(serverEnd);
  await client.start();
  let next = 1;
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<{ result?: Record<string, any>; error?: unknown }>((resolve) => {
      const id = next++;
      pending.set(id, (m) => resolve(m as never));
      void client.send({ jsonrpc: "2.0", id, method, params });
    });
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  expect(init.error).toBeUndefined();
  await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { request, close: () => server.close() };
}

const fakeSession = (over: Partial<SessionService> = {}): SessionService => ({
  login: async () => ({ status: "signed_in", account: "a@outlook.com" }),
  logout: async () => ({}),
  ...over,
});

const LOCAL_LINK =
  "This unsubscribe link points to this computer or the local network, which a real newsletter never does. It was not opened. Treat this message as suspicious.";
const HTTP_LINK = "This unsubscribe link is not encrypted (http) and was not opened.";

type ListedTool = {
  name: string;
  description: string;
  annotations: Record<string, boolean>;
  inputSchema: { properties: Record<string, Record<string, unknown>> };
  outputSchema: { properties: Record<string, any> };
};

async function listTools(request: Awaited<ReturnType<typeof connect>>["request"]): Promise<Map<string, ListedTool>> {
  const list = await request("tools/list");
  return new Map((list.result?.tools as ListedTool[]).map((t) => [t.name, t]));
}

describe("mail_senders_summary over the wire", () => {
  const sender = (address: string, unsubscribe: UnsubscribeInfo) => ({
    address, name: "", domain: "x.example", count: 1, unreadCount: 0,
    lastReceived: "2026-01-01T00:00:00Z", lastSubject: "s", lastMessageId: `id-${address}`, unsubscribe,
  });

  it("labels each sender with the method mail_unsubscribe would use", async () => {
    const senders = [
      sender("oneclick@x.example", { oneClick: true, https: "https://x.example/1", mailto: "u@x.example" }),
      // A link and a mailto without one-click: mail_unsubscribe hands over the link, so no email is needed.
      sender("both@x.example", { oneClick: false, https: "https://x.example/2", mailto: "u@x.example" }),
      sender("mailto@x.example", { oneClick: false, mailto: "u@x.example" }),
      sender("none@x.example", { oneClick: false }),
    ];
    const mail = { sendersSummary: async () => ({ scanned: 4, totalSenders: 4, senders }) } as unknown as MailService;
    const { request, close } = await connect(fakeSession(), mail);
    const res = await request("tools/call", { name: "mail_senders_summary", arguments: {} });
    const labels = (res.result?.content[0].text as string)
      .split("\n")
      .slice(1)
      .map((line) => /<([^>]+)>.*\| unsubscribe: ([a-z-]+) \|/.exec(line)?.slice(1, 3));
    expect(labels).toEqual([
      ["oneclick@x.example", "one-click"],
      ["both@x.example", "browser"],
      ["mailto@x.example", "mailto"],
      ["none@x.example", "none"],
    ]);
    const tool = (await listTools(request)).get("mail_senders_summary");
    expect(tool?.description).toMatch(/one-click, browser .*mailto .*blocked .*or none/);
    expect(tool?.outputSchema.properties.senders.items.properties.unsubscribe.properties.method.enum).toEqual(["one-click", "browser", "mailto", "blocked", "none"]);
    await close();
  });

  it("labels a link mail_unsubscribe would block as blocked, without DNS, and never shows it", async () => {
    const senders = [
      sender("private@x.example", { oneClick: true, https: "https://192.168.1.1/u", mailto: "u@x.example" }),
      sender("loopback@x.example", { oneClick: false, https: "https://[::1]/u" }),
      sender("localhost@x.example", { oneClick: true, https: "https://localhost:8080/u", mailto: "u@x.example" }),
      sender("sublocalhost@x.example", { oneClick: false, https: "https://app.localhost/u" }),
      sender("httplocal@x.example", { oneClick: false, https: "http://10.0.0.1/u", mailto: "u@x.example" }),
      sender("httpmailto@x.example", { oneClick: false, https: "http://plain.example/u", mailto: "u@x.example" }),
      sender("httponly@x.example", { oneClick: false, https: "http://plain.example/v" }),
      // Only a lookup can tell where a name points: mail_unsubscribe checks it when it runs.
      sender("name@x.example", { oneClick: false, https: "https://name.example/u" }),
      sender("publicip@x.example", { oneClick: false, https: "https://93.184.215.14/u" }),
    ];
    const mail = { sendersSummary: async () => ({ scanned: 9, totalSenders: 9, senders }) } as unknown as MailService;
    const { request, close } = await connect(fakeSession(), mail);
    const res = await request("tools/call", { name: "mail_senders_summary", arguments: {} });
    expect(res.result?.isError).toBeFalsy();
    const labels = (res.result?.content[0].text as string)
      .split("\n")
      .slice(1)
      .map((line) => /<([^>]+)>.*\| unsubscribe: ([a-z-]+) \|/.exec(line)?.slice(1, 3));
    expect(labels).toEqual([
      ["private@x.example", "blocked"],
      ["loopback@x.example", "blocked"],
      ["localhost@x.example", "blocked"],
      ["sublocalhost@x.example", "blocked"],
      ["httplocal@x.example", "blocked"],
      ["httpmailto@x.example", "mailto"],
      ["httponly@x.example", "blocked"],
      ["name@x.example", "browser"],
      ["publicip@x.example", "browser"],
    ]);
    const unsub = (res.result?.structuredContent as { senders: { unsubscribe: unknown }[] }).senders.map((s) => s.unsubscribe);
    expect(unsub[0]).toEqual({ method: "blocked", oneClick: false, detail: LOCAL_LINK });
    expect(unsub[2]).toEqual({ method: "blocked", oneClick: false, detail: LOCAL_LINK });
    expect(unsub[4]).toEqual({ method: "blocked", oneClick: false, detail: LOCAL_LINK });
    expect(unsub[5]).toEqual({
      method: "mailto",
      oneClick: false,
      mailto: "u@x.example",
      detail: `${HTTP_LINK} The sender also accepts unsubscribe requests by email.`,
    });
    expect(unsub[6]).toEqual({ method: "blocked", oneClick: false, detail: HTTP_LINK });
    expect(unsub[7]).toEqual({ method: "browser", oneClick: false, https: "https://name.example/u" });
    const everything = JSON.stringify(res.result);
    for (const hidden of ["192.168.1.1", "[::1]", "localhost:8080", "app.localhost", "10.0.0.1", "http://plain.example"]) {
      expect(everything).not.toContain(hidden);
    }
    await close();
  });
});

describe("mail_get_message over the wire", () => {
  const read = (unsubscribe: UnsubscribeInfo) =>
    ({
      getMessage: async () => ({
        summary: { id: "m", from: "news@x.example", fromName: "News", subject: "Promo", receivedDateTime: "2026-01-01T00:00:00Z", isRead: true, preview: "" },
        to: ["me@outlook.com"],
        body: "Hello",
        truncated: false,
        hasAttachments: false,
        unsubscribe,
      }),
    }) as unknown as MailService;

  it("does not present a link mail_unsubscribe would block as something to open", async () => {
    const { request, close } = await connect(fakeSession(), read({ oneClick: true, https: "https://192.168.1.1/u", mailto: "stop@x.example" }));
    const res = await request("tools/call", { name: "mail_get_message", arguments: { id: "m" } });
    expect(res.result?.isError).toBeFalsy();
    expect(res.result?.structuredContent.unsubscribe).toEqual({ method: "blocked", oneClick: false, detail: LOCAL_LINK });
    const text = res.result?.content[0].text as string;
    expect(text).toContain(`Unsubscribe: blocked. ${LOCAL_LINK}`);
    expect(JSON.stringify(res.result)).not.toContain("192.168.1.1");
    expect(JSON.stringify(res.result)).not.toContain("stop@x.example");
    await close();
  });

  it("shows the mailto address, not a plain http link, when http falls back to email", async () => {
    const { request, close } = await connect(fakeSession(), read({ oneClick: false, https: "http://plain.example/u", mailto: "stop@x.example" }));
    const res = await request("tools/call", { name: "mail_get_message", arguments: { id: "m" } });
    expect(res.result?.structuredContent.unsubscribe).toEqual({
      method: "mailto",
      oneClick: false,
      mailto: "stop@x.example",
      detail: `${HTTP_LINK} The sender also accepts unsubscribe requests by email.`,
    });
    expect(res.result?.content[0].text).toContain("Unsubscribe: mailto stop@x.example");
    expect(JSON.stringify(res.result)).not.toContain("http://plain.example");
    await close();
  });

  it("shows an https link to a host name, labelled with the method", async () => {
    const { request, close } = await connect(fakeSession(), read({ oneClick: false, https: "https://x.example/page", mailto: "stop@x.example" }));
    const res = await request("tools/call", { name: "mail_get_message", arguments: { id: "m" } });
    expect(res.result?.structuredContent.unsubscribe).toEqual({ method: "browser", oneClick: false, https: "https://x.example/page", mailto: "stop@x.example" });
    expect(res.result?.content[0].text).toContain("Unsubscribe: URL https://x.example/page / mailto stop@x.example");
    const tool = (await listTools(request)).get("mail_get_message");
    expect(tool?.description).toContain("blocked");
    expect(tool?.outputSchema.properties.unsubscribe.properties.method.enum).toContain("blocked");
    await close();
  });
});

describe("destructive tools", () => {
  it("mail_purge permanently deletes by id, says it cannot be undone, and is marked destructive", async () => {
    const purged: string[][] = [];
    let invalidated = 0;
    const mail = {
      permanentDelete: async (ids: string[]) => {
        purged.push(ids);
        return ids.map((id) => ({ id, ok: true }));
      },
      invalidateSummaries: () => invalidated++,
    } as unknown as MailService;
    const { request, close } = await connect(fakeSession(), mail);
    const tool = (await listTools(request)).get("mail_purge");
    expect(tool?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
    expect(tool?.description).toMatch(/cannot be undone/);
    expect(tool?.description).toMatch(/only .*when the user explicitly asked/i);
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["ids"]);
    expect(tool?.inputSchema.properties.ids).toMatchObject({ minItems: 1, maxItems: 500 });
    const res = await request("tools/call", { name: "mail_purge", arguments: { ids: ["a", "b"] } });
    expect(res.result?.isError).toBeFalsy();
    expect(res.result?.content[0].text).toBe("2 message(s) permanently deleted.");
    expect(res.result?.structuredContent).toEqual({ succeeded: 2, failed: [] });
    expect(purged).toEqual([["a", "b"]]);
    expect(invalidated).toBe(1);
    await close();
  });

  it("mail_delete only moves to Deleted Items: it refuses `permanent` and is not marked destructive", async () => {
    const deleted: unknown[][] = [];
    const mail = {
      delete: async (...args: unknown[]) => {
        deleted.push(args);
        return (args[0] as string[]).map((id) => ({ id, ok: true, newId: `NEW_${id}` }));
      },
      permanentDelete: async () => {
        throw new Error("mail_delete must never delete permanently");
      },
      invalidateSummaries: () => {},
    } as unknown as MailService;
    const { request, close } = await connect(fakeSession(), mail);
    const tool = (await listTools(request)).get("mail_delete");
    expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(["ids"]);
    expect(tool?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    expect(tool?.description).toContain("mail_purge");
    const refused = await request("tools/call", { name: "mail_delete", arguments: { ids: ["a"], permanent: true } });
    expect(refused.result?.isError === true || refused.error !== undefined).toBe(true);
    expect(deleted).toEqual([]);
    const res = await request("tools/call", { name: "mail_delete", arguments: { ids: ["a"] } });
    expect(res.result?.content[0].text).toMatch(/^1 message\(s\) moved to Deleted Items\./);
    expect(deleted).toEqual([[["a"]]]);
    await close();
  });

  it("marks unsubscribing as destructive and the tools that return email content as open-world", async () => {
    const { request, close } = await connect(fakeSession());
    const tools = await listTools(request);
    expect(tools.get("mail_unsubscribe")?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    for (const name of ["mail_search", "mail_get_message", "mail_senders_summary"]) {
      expect(tools.get(name)?.annotations, name).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    }
    await close();
  });
});

describe("mail_bulk_by_sender over the wire", () => {
  const FOLDERS = {
    value: [{ id: "F_NEWS".padEnd(70, "n"), displayName: "Newsletters", totalItemCount: 0, unreadItemCount: 0, childFolderCount: 0 }],
  };

  /** A real MailService on a fake Graph where `count` messages come from the sender, in pages of 1,000. */
  function graphWith(count: number) {
    const posts: { url: string; requests: { id: string; method: string; url: string; body?: { destinationId?: string } }[] }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if ((init.method ?? "GET") === "POST") {
        const requests = JSON.parse(init.body as string).requests as (typeof posts)[number]["requests"];
        posts.push({ url, requests });
        return json({ responses: requests.map((r) => ({ id: r.id, status: 201, body: { id: `NEW_${r.id}` } })) });
      }
      if (url.includes("/me/mailFolders?")) return json(FOLDERS);
      const page = Number(new URL(url).searchParams.get("page") ?? "0");
      const ids = Array.from({ length: Math.max(0, Math.min(1000, count - page * 1000)) }, (_, i) => ({ id: `m${page * 1000 + i}` }));
      const more = (page + 1) * 1000 < count;
      return json({ value: ids, ...(more ? { "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?page=${page + 1}` } : {}) });
    }) as unknown as typeof fetch;
    const graph = new GraphClient({ getToken: async () => "tok", fetchImpl: f, sleep: async () => {} });
    return { mail: new MailServiceImpl(graph), posts };
  }

  it("dry-runs by default: reports how many messages it would act on and changes nothing", async () => {
    const { mail, posts } = graphWith(3);
    const { request, close } = await connect(fakeSession(), mail);
    const tool = (await listTools(request)).get("mail_bulk_by_sender");
    expect(tool?.inputSchema.properties.dryRun?.default).toBe(true);
    expect(tool?.inputSchema.properties).not.toHaveProperty("permanent");
    expect(tool?.outputSchema.properties).toHaveProperty("capped");
    const res = await request("tools/call", { name: "mail_bulk_by_sender", arguments: { from: "news@x.example", action: "delete" } });
    expect(res.result?.isError).toBeFalsy();
    expect(res.result?.structuredContent).toEqual({ matched: 3, capped: false, dryRun: true, succeeded: 0, failed: [] });
    expect(res.result?.content[0].text).toBe(
      '3 message(s) from news@x.example in "inbox" would be moved to Deleted Items. Nothing changed (dry run): once the user confirms, call again with dryRun: false.',
    );
    expect(posts).toEqual([]);
    await close();
  });

  it("with dryRun: false, moves the messages to Deleted Items and never deletes them permanently", async () => {
    const { mail, posts } = graphWith(3);
    const { request, close } = await connect(fakeSession(), mail);
    const res = await request("tools/call", { name: "mail_bulk_by_sender", arguments: { from: "news@x.example", action: "delete", dryRun: false } });
    expect(res.result?.structuredContent).toMatchObject({ matched: 3, capped: false, dryRun: false, succeeded: 3, failed: [] });
    const sent = posts.flatMap((p) => p.requests);
    expect(sent.map((r) => `${r.method} ${r.url} -> ${r.body?.destinationId}`)).toEqual([
      "POST /me/messages/m0/move -> deleteditems",
      "POST /me/messages/m1/move -> deleteditems",
      "POST /me/messages/m2/move -> deleteditems",
    ]);
    await close();
  });

  it("refuses `permanent` and touches nothing", async () => {
    const { mail, posts } = graphWith(3);
    const { request, close } = await connect(fakeSession(), mail);
    const res = await request("tools/call", { name: "mail_bulk_by_sender", arguments: { from: "news@x.example", action: "delete", permanent: true, dryRun: false } });
    expect(res.result?.isError === true || res.error !== undefined).toBe(true);
    expect(posts).toEqual([]);
    await close();
  });

  it("checks the destination folder during the dry run", async () => {
    const { mail, posts } = graphWith(3);
    const { request, close } = await connect(fakeSession(), mail);
    const missing = await request("tools/call", { name: "mail_bulk_by_sender", arguments: { from: "news@x.example", action: "move", targetFolder: "Nowhere" } });
    expect(missing.result?.isError).toBe(true);
    expect(missing.result?.content[0].text).toMatch(/Folder "Nowhere" not found/);
    const found = await request("tools/call", { name: "mail_bulk_by_sender", arguments: { from: "news@x.example", action: "move", targetFolder: "Newsletters" } });
    expect(found.result?.content[0].text).toMatch(/^3 message\(s\) from news@x\.example in "inbox" would be moved to "Newsletters"\. Nothing changed/);
    expect(posts).toEqual([]);
    await close();
  });

  it("says so when it stops at the 5,000-message limit", async () => {
    const { mail, posts } = graphWith(5200);
    const { request, close } = await connect(fakeSession(), mail);
    const dry = await request("tools/call", { name: "mail_bulk_by_sender", arguments: { from: "news@x.example", action: "delete" } });
    expect(dry.result?.structuredContent).toEqual({ matched: 5000, capped: true, dryRun: true, succeeded: 0, failed: [] });
    expect(dry.result?.content[0].text).toContain(
      "This sender has more than 5,000 messages in this folder, the most one call handles: a run acts on 5,000 of them, then call again for the rest.",
    );
    const run = await request("tools/call", { name: "mail_bulk_by_sender", arguments: { from: "news@x.example", action: "delete", dryRun: false } });
    expect(run.result?.structuredContent).toMatchObject({ matched: 5000, capped: true, dryRun: false, succeeded: 5000 });
    expect(run.result?.content[0].text).toContain(
      "This sender has more than 5,000 messages in this folder, the most one call handles: call again for the rest.",
    );
    expect(posts.flatMap((p) => p.requests)).toHaveLength(5000);
    await close();
  });

  it("does not ask for a second call when nothing matches", async () => {
    const { mail, posts } = graphWith(0);
    const { request, close } = await connect(fakeSession(), mail);
    const res = await request("tools/call", { name: "mail_bulk_by_sender", arguments: { from: "news@x.example", action: "delete" } });
    expect(res.result?.structuredContent).toEqual({ matched: 0, capped: false, dryRun: true, succeeded: 0, failed: [] });
    expect(res.result?.content[0].text).toBe('0 message(s) from news@x.example in "inbox". Nothing to do.');
    expect(posts).toEqual([]);
    await close();
  });

  it("is not capped at exactly 5,000 messages", async () => {
    const { mail } = graphWith(5000);
    const { request, close } = await connect(fakeSession(), mail);
    const dry = await request("tools/call", { name: "mail_bulk_by_sender", arguments: { from: "news@x.example", action: "delete" } });
    expect(dry.result?.structuredContent).toMatchObject({ matched: 5000, capped: false });
    expect(dry.result?.content[0].text).not.toContain("5,000");
    await close();
  });
});

describe("mail_unsubscribe over the wire", () => {
  it("returns a blocked link without any URL, and its description explains `blocked`", async () => {
    const detail =
      "This unsubscribe link points to this computer or the local network, which a real newsletter never does. It was not opened. Treat this message as suspicious.";
    const outcome = { method: "blocked", ok: false, detail, from: "news@x.example", subject: "Promo" };
    const mail = { unsubscribe: async () => outcome } as unknown as MailService;
    const { request, close } = await connect(fakeSession(), mail);
    const res = await request("tools/call", { name: "mail_unsubscribe", arguments: { id: "m" } });
    expect(res.result?.isError).toBeFalsy();
    expect(res.result?.structuredContent).toEqual(outcome);
    expect(res.result?.content[0].text).toBe(`⛔ Unsubscribe link blocked for news@x.example.\n${detail}`);
    const list = await request("tools/list");
    const tool = (list.result?.tools as { name: string; description: string; outputSchema: { properties: { method: { enum: string[] } } } }[]).find(
      (t) => t.name === "mail_unsubscribe",
    );
    expect(tool?.description).toContain('`method: "blocked"`');
    expect(tool?.outputSchema.properties.method.enum).toContain("blocked");
    await close();
  });
});

describe("mail_search cursor", () => {
  it("refuses a cursor that points outside Microsoft Graph and makes no request", async () => {
    const urls: string[] = [];
    const f = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const graph = new GraphClient({ getToken: async () => "tok", fetchImpl: f, sleep: async () => {} });
    const mail = new MailServiceImpl(graph);
    const { request, close } = await connect(fakeSession(), mail);
    const res = await request("tools/call", { name: "mail_search", arguments: { cursor: "https://attacker.example/steal" } });
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content[0].text).toBe(
      "Refused to call a URL outside Microsoft Graph. Pass back the cursor exactly as mail_search returned it.",
    );
    expect(urls).toEqual([]);
    await close();
  });
});

describe("session tools over the wire", () => {
  it("lists the ten mail tools plus mail_login and mail_logout", async () => {
    const { request, close } = await connect(fakeSession());
    const list = await request("tools/list");
    const names = (list.result?.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "mail_bulk_by_sender", "mail_create_folder", "mail_delete", "mail_get_message", "mail_list_folders",
        "mail_login", "mail_logout", "mail_move", "mail_purge", "mail_search", "mail_senders_summary", "mail_unsubscribe",
      ].sort(),
    );
    expect(names).toHaveLength(12);
    const login = (list.result?.tools as { name: string; description: string; annotations: unknown }[]).find((t) => t.name === "mail_login");
    expect(login?.description).toMatch(/never asks? for permission to send/i);
    expect(login?.description).toContain("Not signed in");
    await close();
  });

  it("mail_login reports a pending sign-in with its link", async () => {
    const url = "https://login.microsoftonline.com/x";
    const { request, close } = await connect(fakeSession({ login: async () => ({ status: "pending", url }) }));
    const res = await request("tools/call", { name: "mail_login", arguments: {} });
    expect(res.result?.structuredContent).toMatchObject({ status: "pending", url });
    expect(res.result?.content[0].text).toBe(
      `A Microsoft sign-in page was opened in the user's browser. Ask them to finish signing in there, then call mail_login again. If no page opened, give them this link: ${url}`,
    );
    await close();
  });

  it("mail_login signed in and failed texts", async () => {
    const a = await connect(fakeSession());
    const ok = await a.request("tools/call", { name: "mail_login", arguments: {} });
    expect(ok.result?.structuredContent).toEqual({ status: "signed_in", account: "a@outlook.com", detail: "Signed in as a@outlook.com." });
    await a.close();
    const b = await connect(fakeSession({ login: async () => ({ status: "failed", detail: "Timed out." }) }));
    const bad = await b.request("tools/call", { name: "mail_login", arguments: {} });
    expect(bad.result?.structuredContent).toEqual({ status: "failed", detail: "Sign-in did not complete: Timed out. Call mail_login to try again." });
    await b.close();
  });

  it("mail_logout returns the consent URL, with or without an account", async () => {
    const a = await connect(fakeSession({ logout: async () => ({ account: "a@outlook.com" }) }));
    const out = await a.request("tools/call", { name: "mail_logout", arguments: {} });
    expect(out.result?.structuredContent).toEqual({
      signedOut: true,
      account: "a@outlook.com",
      revokeUrl: "https://microsoft.com/consent",
      detail:
        "Signed out of a@outlook.com. The local sign-in was removed. To also withdraw Mail-MCP's access on Microsoft's side, the user can open https://microsoft.com/consent.",
    });
    await a.close();
    const b = await connect(fakeSession());
    const none = await b.request("tools/call", { name: "mail_logout", arguments: {} });
    expect(none.result?.structuredContent).toEqual({
      signedOut: false,
      revokeUrl: "https://microsoft.com/consent",
      detail: "No account was signed in. To withdraw Mail-MCP's access on Microsoft's side, the user can open https://microsoft.com/consent.",
    });
    await b.close();
  });

  it("copies only the listed fields: a token that leaks into the service result never reaches the client", async () => {
    const leaky = (async () => ({ account: "a@outlook.com", accessToken: "eyJsecret" })) as unknown as SessionService["logout"];
    const { request, close } = await connect(fakeSession({ logout: leaky }));
    const res = await request("tools/call", { name: "mail_logout", arguments: {} });
    expect(JSON.stringify(res.result)).not.toContain("eyJsecret");
    await close();
  });

  it("rejects unknown input", async () => {
    const { request, close } = await connect(fakeSession());
    const res = await request("tools/call", { name: "mail_login", arguments: { extra: 1 } });
    expect(res.result?.isError === true || res.error !== undefined).toBe(true);
    await close();
  });
});
