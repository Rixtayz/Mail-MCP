import { connect, createServer, type AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/constants.js";
import {
  buildMailtoUrl,
  embeddedIPv4,
  oneClickPost,
  parseListUnsubscribe,
  splitListUnsubscribe,
  type HostResolver,
  type OneClickResult,
  type RequestFn,
} from "../src/unsubscribe.js";
import { fakeRequest } from "./fake-request.js";

// A test that falls back to the real resolver fails instead of reaching the network.
vi.mock("node:dns/promises", () => ({
  lookup: async () => {
    throw new Error("a test used the real DNS resolver");
  },
}));

const h = (name: string, value: string) => ({ name, value });

describe("splitListUnsubscribe", () => {
  it("extracts angle-bracketed entries and strips folded whitespace", () => {
    expect(splitListUnsubscribe("<https://a.example/u?x=1>,\r\n <mailto:u@a.example>")).toEqual([
      "https://a.example/u?x=1",
      "mailto:u@a.example",
    ]);
  });
  it("returns empty for garbage", () => {
    expect(splitListUnsubscribe("nothing here")).toEqual([]);
  });
});

describe("parseListUnsubscribe", () => {
  it("returns oneClick=false with no header", () => {
    expect(parseListUnsubscribe(undefined)).toEqual({ oneClick: false });
    expect(parseListUnsubscribe([h("Subject", "x")])).toEqual({ oneClick: false });
  });

  it("mailto only", () => {
    const info = parseListUnsubscribe([h("List-Unsubscribe", "<mailto:unsub@news.example?subject=stop%20it>")]);
    expect(info).toEqual({ oneClick: false, mailto: "unsub@news.example", mailtoSubject: "stop it" });
  });

  it("https only without POST header is browser-only", () => {
    const info = parseListUnsubscribe([h("List-Unsubscribe", "<https://news.example/unsub?t=abc>")]);
    expect(info).toEqual({ oneClick: false, https: "https://news.example/unsub?t=abc" });
  });

  it("https + List-Unsubscribe-Post enables one-click (case-insensitive header names)", () => {
    const info = parseListUnsubscribe([
      h("list-unsubscribe", "<mailto:u@x.example>, <https://x.example/u/1>"),
      h("LIST-UNSUBSCRIBE-POST", "List-Unsubscribe=One-Click"),
    ]);
    expect(info.oneClick).toBe(true);
    expect(info.https).toBe("https://x.example/u/1");
    expect(info.mailto).toBe("u@x.example");
  });

  it("http (non-TLS) never qualifies for one-click", () => {
    const info = parseListUnsubscribe([
      h("List-Unsubscribe", "<http://x.example/u>"),
      h("List-Unsubscribe-Post", "List-Unsubscribe=One-Click"),
    ]);
    expect(info.oneClick).toBe(false);
    expect(info.https).toBe("http://x.example/u");
  });

  it("prefers an https link to an http one listed before it", () => {
    const info = parseListUnsubscribe([
      h("List-Unsubscribe", "<http://x.example/u>, <https://x.example/s>"),
      h("List-Unsubscribe-Post", "List-Unsubscribe=One-Click"),
    ]);
    expect(info.https).toBe("https://x.example/s");
    expect(info.oneClick).toBe(true);
  });

  it("wrong POST header value does not enable one-click", () => {
    const info = parseListUnsubscribe([
      h("List-Unsubscribe", "<https://x.example/u>"),
      h("List-Unsubscribe-Post", "something-else"),
    ]);
    expect(info.oneClick).toBe(false);
  });

  it("strips control characters from the raw mailto subject and body and caps them at 200 and 1000 characters", () => {
    const subject = encodeURIComponent("Stop\r\nBcc: v@y.example\u0000" + "s".repeat(300));
    const body = encodeURIComponent("a\u001b[2Jb\u0085" + "b".repeat(2000));
    const info = parseListUnsubscribe([h("List-Unsubscribe", `<mailto:stop@x.example?subject=${subject}&body=${body}>`)]);
    expect(info.mailtoSubject).toBe(("StopBcc: v@y.example" + "s".repeat(300)).slice(0, 200));
    expect(info.mailtoBody).toBe(("a[2Jb" + "b".repeat(2000)).slice(0, 1000));
  });
});

/** Fake DNS: every hostname resolves to a public address. */
const publicDns: HostResolver = async () => [{ address: "93.184.215.14", family: 4 }];

describe("oneClickPost", () => {
  it("POSTs the fixed body and User-Agent over https to the checked address", async () => {
    const { request, sent } = fakeRequest(200);
    const r = await oneClickPost("https://x.example/u?t=1", { resolveHost: publicDns, request });
    expect(r).toEqual({ ok: true, status: 200, detail: "One-click POST accepted (HTTP 200)." });
    expect(sent).toHaveLength(1);
    const { options, body, connectedTo } = sent[0]!;
    expect(options).toMatchObject({ protocol: "https:", hostname: "x.example", port: 443, path: "/u?t=1", method: "POST", agent: false });
    expect(options.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": "26",
      "User-Agent": `mail-mcp/${VERSION}`,
    });
    expect(body).toBe("List-Unsubscribe=One-Click");
    expect(connectedTo).toEqual(["93.184.215.14"]);
  });

  it("discards the response body unread", async () => {
    const { request, sent } = fakeRequest(200);
    await oneClickPost("https://x.example/u", { resolveHost: publicDns, request });
    expect(sent[0]?.responseDestroyed).toBe(true);
  });

  it("treats a redirect as failure and does not follow it", async () => {
    const { request, sent } = fakeRequest(302);
    const r = await oneClickPost("https://x.example/u", { resolveHost: publicDns, request });
    expect(r).toMatchObject({ ok: false, status: 302 });
    expect(r.refusal).toBeUndefined();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.responseDestroyed).toBe(true);
  });

  it("treats a rejection as failure", async () => {
    const { request } = fakeRequest(500);
    const r = await oneClickPost("https://x.example/u", { resolveHost: publicDns, request });
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(r.detail).toContain("HTTP 500");
  });

  it("treats network errors as failure without throwing", async () => {
    const { request } = fakeRequest(new Error("ECONNRESET"));
    const r = await oneClickPost("https://x.example/u", { resolveHost: publicDns, request });
    expect(r.ok).toBe(false);
    expect(r.refusal).toBeUndefined();
    expect(r.detail).toContain("ECONNRESET");
  });

  it("treats a request that throws as failure without throwing", async () => {
    const request = (() => {
      throw new Error("boom");
    }) as unknown as RequestFn;
    const r = await oneClickPost("https://x.example/u", { resolveHost: publicDns, request });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("boom");
  });

  it("gives up after 15 seconds and closes the request", async () => {
    vi.useFakeTimers();
    try {
      const { request, sent, destroyed } = fakeRequest("hang");
      let result: OneClickResult | undefined;
      void oneClickPost("https://x.example/u", { resolveHost: publicDns, request }).then((r) => (result = r));
      await vi.advanceTimersByTimeAsync(14_999);
      expect(sent).toHaveLength(1);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toMatchObject({ ok: false });
      expect(result?.detail).toContain("15 s");
      expect(destroyed).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands the socket only the addresses that were checked", async () => {
    const dns: HostResolver = async () => [{ address: "93.184.215.14", family: 4 }, { address: "2606:2800:220:1::1", family: 6 }];
    const { request, sent } = fakeRequest(200);
    await oneClickPost("https://x.example/u", { resolveHost: dns, request });
    expect(sent[0]?.connectedTo).toEqual(["93.184.215.14", "2606:2800:220:1::1"]);
  });

  it("answers a lookup for a single address with a checked one", async () => {
    const { request, attempts } = fakeRequest(200);
    await oneClickPost("https://x.example/u", { resolveHost: publicDns, request });
    const lookup = attempts[0]!.lookup!;
    const single = await new Promise((resolve, reject) =>
      lookup("x.example", {}, (err, address, family) => (err ? reject(err) : resolve({ address, family }))),
    );
    expect(single).toEqual({ address: "93.184.215.14", family: 4 });
  });

  it("refuses the whole request when the connection's lookup finds any non-public address", async () => {
    const answers = [[{ address: "93.184.215.14" }], [{ address: "93.184.215.14" }, { address: "10.0.0.7" }]];
    const dns: HostResolver = async () => answers.shift() ?? [];
    const { request, attempts, sent } = fakeRequest(200);
    const r = await oneClickPost("https://x.example/u", { resolveHost: dns, request });
    expect(attempts).toHaveLength(1);
    expect(sent).toEqual([]);
    expect(r).toMatchObject({ ok: false, refusal: { reason: "non-public" } });
    expect(r.detail).toContain("10.0.0.7");
  });

  it("never reaches a listener on 127.0.0.1 when the name rebinds between the check and the connection", async () => {
    const reached: string[] = [];
    const server = createServer((socket) => {
      reached.push(String(socket.remoteAddress));
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      // The listener is live: a direct connection reaches it.
      await new Promise<void>((resolve, reject) => {
        const s = connect(port, "127.0.0.1", () => {
          s.destroy();
          resolve();
        });
        s.on("error", reject);
      });
      await vi.waitFor(() => expect(reached).toHaveLength(1));
      reached.length = 0;

      // The guard is told a public address, the connection 127.0.0.1. The real https.request is used.
      const answers = [[{ address: "93.184.215.14", family: 4 }]];
      const asked: string[] = [];
      const rebinding: HostResolver = async (host) => {
        asked.push(host);
        return answers.shift() ?? [{ address: "127.0.0.1", family: 4 }];
      };
      const r = await oneClickPost(`https://rebind.test:${port}/u`, { resolveHost: rebinding });
      expect(asked).toEqual(["rebind.test", "rebind.test"]);
      expect(r).toMatchObject({ ok: false, refusal: { reason: "non-public" } });
      expect(r.detail).toContain("127.0.0.1");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(reached).toEqual([]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("oneClickPost destination guard", () => {
  it.each([
    "https://localhost/u",
    "https://LOCALHOST./u",
    "https://news.localhost/u",
    "https://127.0.0.1/u",
    "https://127.1/u",
    "https://2130706433/u",
    "https://0.0.0.0/u",
    "https://10.1.2.3/u",
    "https://172.16.0.1/u",
    "https://172.31.255.254/u",
    "https://192.168.1.1/u",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.0.1/u",
    "https://224.0.0.251/u",
    "https://255.255.255.255/u",
    "https://192.0.0.1/u",
    "https://192.0.0.170/u",
    "https://198.18.0.1/u",
    "https://198.19.255.254/u",
    "https://[::1]/u",
    "https://[::]/u",
    "https://[::127.0.0.1]/u",
    "https://[fd12:3456::1]/u",
    "https://[fc00::1]/u",
    "https://[fe80::1]/u",
    "https://[fec0::1]/u",
    "https://[ff02::1]/u",
    "https://[::ffff:127.0.0.1]/u",
    "https://[::ffff:192.168.1.1]/u",
    "https://[64:ff9b::808:808]/u",
    "https://[64:ff9b::7f00:1]/u",
    "https://[64:ff9b:1::808:808]/u",
    "https://[2002:808:808::1]/u",
    "https://[2002:c0a8:101::1]/u",
    "https://[::ffff:0:808:808]/u",
    "https://[::ffff:0:a00:1]/u",
  ])("refuses %s without sending anything", async (url) => {
    const { request, attempts } = fakeRequest(200);
    const r = await oneClickPost(url, { resolveHost: publicDns, request });
    expect(attempts).toEqual([]);
    expect(r).toMatchObject({ ok: false, refusal: { reason: "non-public" } });
    expect(r.detail).not.toMatch(/browser/i);
  });

  it.each([
    "192.168.1.1",
    "fd00::10",
    "198.18.5.5",
    "192.0.0.8",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b:1::1:2",
    "2002:a00:1::1",
    "::ffff:0:7f00:1",
    "fe80::1%15",
  ])("refuses a hostname when one of its addresses is %s", async (address) => {
    const { request, attempts } = fakeRequest(200);
    const dns: HostResolver = async () => [{ address: "93.184.215.14" }, { address }];
    const r = await oneClickPost("https://router.example/u", { resolveHost: dns, request });
    expect(attempts).toEqual([]);
    expect(r).toMatchObject({ ok: false, refusal: { reason: "non-public" } });
    expect(r.detail).toContain(address);
  });

  it("refuses when the hostname cannot be resolved", async () => {
    const { request, attempts } = fakeRequest(200);
    const dns: HostResolver = async () => {
      throw new Error("getaddrinfo ENOTFOUND nowhere.example");
    };
    const r = await oneClickPost("https://nowhere.example/u", { resolveHost: dns, request });
    expect(attempts).toEqual([]);
    expect(r).toMatchObject({ ok: false, refusal: { reason: "unverifiable" } });
    expect(r.detail).toContain("ENOTFOUND");
  });

  it("refuses a URL whose host cannot be parsed", async () => {
    const { request, attempts } = fakeRequest(200);
    const r = await oneClickPost("https://[zz]/u", { resolveHost: publicDns, request });
    expect(attempts).toEqual([]);
    expect(r).toMatchObject({ ok: false, refusal: { reason: "unverifiable" } });
  });

  it("refuses a plain http URL", async () => {
    const { request, attempts } = fakeRequest(200);
    const r = await oneClickPost("http://x.example/u", { resolveHost: publicDns, request });
    expect(attempts).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it("posts to a public hostname after resolving that hostname, for the guard and for the connection", async () => {
    const { request, sent } = fakeRequest(200);
    const asked: string[] = [];
    const dns: HostResolver = async (host) => {
      asked.push(host);
      return publicDns(host);
    };
    const r = await oneClickPost("https://Example.com:8443/u?t=1", { resolveHost: dns, request });
    expect(asked).toEqual(["example.com", "example.com"]);
    expect(sent[0]?.options).toMatchObject({ hostname: "example.com", port: 8443, path: "/u?t=1" });
    expect(r.ok).toBe(true);
  });

  it.each([
    ["https://1.1.1.1/u", "1.1.1.1"],
    ["https://172.32.0.1/u", "172.32.0.1"],
    ["https://192.0.1.1/u", "192.0.1.1"],
    ["https://198.20.0.1/u", "198.20.0.1"],
    ["https://[2606:4700:4700::1111]/u", "2606:4700:4700::1111"],
    ["https://[2003::1]/u", "2003::1"],
    ["https://[64:ff9c::1]/u", "64:ff9c::1"],
  ])("posts to the public address %s", async (url, host) => {
    const { request, sent } = fakeRequest(200);
    const r = await oneClickPost(url, { resolveHost: publicDns, request });
    expect(sent.map((s) => s.options.hostname)).toEqual([host]);
    expect(sent[0]?.connectedTo).toEqual([host]);
    expect(r.ok).toBe(true);
  });
});

describe("embeddedIPv4", () => {
  it.each([
    ["64:ff9b::c0a8:101", "192.168.1.1"],
    ["64:ff9b::192.168.1.1", "192.168.1.1"],
    ["64:ff9b:1::a00:1", "10.0.0.1"],
    ["2002:7f00:1::", "127.0.0.1"],
    ["2002:a9fe:a9fe:1::1", "169.254.169.254"],
    ["::ffff:0:a00:1", "10.0.0.1"],
    ["::ffff:0:10.0.0.1", "10.0.0.1"],
  ])("decodes %s to %s", (v6, v4) => {
    expect(embeddedIPv4(v6)).toBe(v4);
  });

  it.each(["2606:4700:4700::1111", "fe80::1", "1.2.3.4", "not an address"])("finds no IPv4 in %s", (address) => {
    expect(embeddedIPv4(address)).toBeUndefined();
  });
});

describe("buildMailtoUrl", () => {
  it("returns undefined without a mailto target", () => {
    expect(buildMailtoUrl({ oneClick: false })).toBeUndefined();
  });
  it("defaults the subject to 'unsubscribe' and omits an absent body", () => {
    expect(buildMailtoUrl({ oneClick: false, mailto: "stop@x.example" })).toBe("mailto:stop@x.example?subject=unsubscribe");
  });
  it("percent-encodes subject and body", () => {
    expect(buildMailtoUrl({ oneClick: false, mailto: "stop@x.example", mailtoSubject: "Unsub me & go", mailtoBody: "a b=c" }))
      .toBe("mailto:stop@x.example?subject=Unsub%20me%20%26%20go&body=a%20b%3Dc");
  });
  it("strips control characters from the subject and body before encoding", () => {
    expect(
      buildMailtoUrl({ oneClick: false, mailto: "stop@x.example", mailtoSubject: "Stop\r\nBcc: v@y.example\u0000", mailtoBody: "a\tb\u001b[2J\u007f\u0085c" }),
    ).toBe("mailto:stop@x.example?subject=StopBcc%3A%20v%40y.example&body=ab%5B2Jc");
    expect(buildMailtoUrl({ oneClick: false, mailto: "stop@x.example", mailtoSubject: "\r\n", mailtoBody: "\u0000" })).toBe(
      "mailto:stop@x.example?subject=unsubscribe",
    );
  });
  it("carries only address, subject and body from a hostile header", () => {
    const info = parseListUnsubscribe([{ name: "List-Unsubscribe", value: "<mailto:stop@x.example?cc=victim@y.example&bcc=v2@y.example&to=v3@y.example&subject=s>" }]);
    const url = buildMailtoUrl(info)!;
    expect(url).toBe("mailto:stop@x.example?subject=s");
  });
  it("encodes an address that tries to smuggle a query", () => {
    expect(buildMailtoUrl({ oneClick: false, mailto: "a@x.example?cc=v@y.example" })).toBe("mailto:a@x.example%3Fcc%3Dv@y.example?subject=unsubscribe");
  });
  it("yields the exact URL for a normal address through the parser", () => {
    const info = parseListUnsubscribe([{ name: "List-Unsubscribe", value: "<mailto:stop@x.example>" }]);
    expect(buildMailtoUrl(info)).toBe("mailto:stop@x.example?subject=unsubscribe");
  });
  it.each([
    ["an encoded comma", "a@x.example%2Cvictim@y.example"],
    ["an encoded CRLF", "a@x.example%0D%0Abcc:v@y.example"],
    ["an encoded space", "a@x.example%20v@y.example"],
    ["an encoded question mark", "a@x.example%3Fcc=v@y.example"],
    ["an encoded ampersand", "a@x.example%26cc=v@y.example"],
    ["two at signs", "a@b@x.example"],
    ["no at sign", "stop.x.example"],
    ["an address over 254 characters", `${"a".repeat(250)}@x.example`],
    ["an encoded right-to-left override", "stop%E2%80%AE@x.example"],
    ["a right-to-left override", "stop\u202E@x.example"],
    ["an encoded zero-width space", "st%E2%80%8Bop@x.example"],
    ["a zero-width joiner", "st\u200Dop@x.example"],
    ["an encoded C1 control character", "stop%C2%85@x.example"],
  ])("treats %s in the address as no mailto target", (_label, address) => {
    const info = parseListUnsubscribe([{ name: "List-Unsubscribe", value: `<mailto:${address}>` }]);
    expect(info.mailto).toBeUndefined();
    expect(buildMailtoUrl(info)).toBeUndefined();
  });
  it("caps subject at 200 characters and body at 1000", () => {
    const url = buildMailtoUrl({ oneClick: false, mailto: "stop@x.example", mailtoSubject: "s".repeat(500), mailtoBody: "b".repeat(5000) })!;
    const q = new URLSearchParams(url.split("?")[1]);
    expect(q.get("subject")).toHaveLength(200);
    expect(q.get("body")).toHaveLength(1000);
  });
  it("never cuts an emoji in half at the subject or body limit", () => {
    // Each emoji is two UTF-16 units, so after the leading "a" both limits fall inside one; half an emoji makes encodeURIComponent throw.
    const subject = "a" + "😀".repeat(150);
    const body = "a" + "😀".repeat(600);
    const info = parseListUnsubscribe([
      { name: "List-Unsubscribe", value: `<mailto:stop@x.example?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}>` },
    ]);
    expect(info.mailtoSubject).toBe("a" + "😀".repeat(99));
    expect(info.mailtoBody).toBe("a" + "😀".repeat(499));
    const url = buildMailtoUrl(info)!;
    const q = new URLSearchParams(url.split("?")[1]);
    expect(q.get("subject")).toBe("a" + "😀".repeat(99));
    expect(q.get("body")).toBe("a" + "😀".repeat(499));
    const direct = new URLSearchParams(buildMailtoUrl({ oneClick: false, mailto: "stop@x.example", mailtoSubject: subject, mailtoBody: body })!.split("?")[1]);
    expect(direct.get("subject")).toBe("a" + "😀".repeat(99));
    expect(direct.get("body")).toBe("a" + "😀".repeat(499));
  });
  it("does not throw on a lone surrogate anywhere, and replaces it", () => {
    const url = buildMailtoUrl({ oneClick: false, mailto: "st\uD800op@x.example", mailtoSubject: "a\uD800b", mailtoBody: "\uDC00c" });
    expect(url).toBe("mailto:st%EF%BF%BDop@x.example?subject=a%EF%BF%BDb&body=%EF%BF%BDc");
  });
  it("treats an address holding a lone surrogate as no mailto target", () => {
    const info = parseListUnsubscribe([{ name: "List-Unsubscribe", value: "<mailto:st\uD800op@x.example>" }]);
    expect(info.mailto).toBeUndefined();
  });
});
