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

describe("mail_senders_summary over the wire", () => {
  it("labels each sender with the method mail_unsubscribe would use", async () => {
    const sender = (address: string, unsubscribe: UnsubscribeInfo) => ({
      address, name: "", domain: "x.example", count: 1, unreadCount: 0,
      lastReceived: "2026-01-01T00:00:00Z", lastSubject: "s", lastMessageId: `id-${address}`, unsubscribe,
    });
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
    const list = await request("tools/list");
    const description = (list.result?.tools as { name: string; description: string }[]).find((t) => t.name === "mail_senders_summary")?.description;
    expect(description).toMatch(/one-click, browser .*mailto .*or none/);
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
    const mail = new MailServiceImpl(graph, f);
    const { request, close } = await connect(fakeSession(), mail);
    const res = await request("tools/call", { name: "mail_search", arguments: { cursor: "https://attacker.example/steal" } });
    expect(res.result?.isError).toBe(true);
    expect(res.result?.content[0].text).toBe(
      "Refused to call a URL outside Microsoft Graph. Pass back the cursor exactly as mail_search returned it.",
    );
    expect(urls.filter((u) => !u.startsWith("https://graph.microsoft.com/v1.0/"))).toEqual([]);
    expect(urls).toEqual([]);
    await close();
  });
});

describe("session tools over the wire", () => {
  it("lists the nine mail tools plus mail_login and mail_logout", async () => {
    const { request, close } = await connect(fakeSession());
    const list = await request("tools/list");
    const names = (list.result?.tools as { name: string }[]).map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "mail_bulk_by_sender", "mail_create_folder", "mail_delete", "mail_get_message", "mail_list_folders",
        "mail_login", "mail_logout", "mail_move", "mail_search", "mail_senders_summary", "mail_unsubscribe",
      ].sort(),
    );
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
