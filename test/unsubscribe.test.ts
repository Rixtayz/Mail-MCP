import { describe, expect, it } from "vitest";
import { buildMailtoUrl, oneClickPost, parseListUnsubscribe, splitListUnsubscribe } from "../src/unsubscribe.js";

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

  it("wrong POST header value does not enable one-click", () => {
    const info = parseListUnsubscribe([
      h("List-Unsubscribe", "<https://x.example/u>"),
      h("List-Unsubscribe-Post", "something-else"),
    ]);
    expect(info.oneClick).toBe(false);
  });
});

/** Fake DNS: every hostname resolves to a public address. */
const publicDns = async () => [{ address: "93.184.215.14", family: 4 }];

/** fetch that answers 200 and records every URL it was asked to hit. */
function recordingFetch() {
  const urls: string[] = [];
  const f = (async (u: string) => {
    urls.push(u);
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  return { f, urls };
}

describe("oneClickPost", () => {
  const mk = (status: number) => (async () => new Response(null, { status })) as unknown as typeof fetch;

  it("succeeds on 2xx and sends the exact body without following redirects", async () => {
    let captured: RequestInit | undefined;
    const f = (async (_u: string, init?: RequestInit) => {
      captured = init;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await oneClickPost("https://x.example/u", f, publicDns);
    expect(r.ok).toBe(true);
    expect(captured?.method).toBe("POST");
    expect(captured?.body).toBe("List-Unsubscribe=One-Click");
    expect(captured?.redirect).toBe("manual");
  });

  it("treats redirects as failure", async () => {
    const r = await oneClickPost("https://x.example/u", mk(302), publicDns);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(302);
  });

  it("treats network errors as failure without throwing", async () => {
    const f = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    const r = await oneClickPost("https://x.example/u", f, publicDns);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("ECONNRESET");
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
  ])("refuses %s without sending anything", async (url) => {
    const { f, urls } = recordingFetch();
    const r = await oneClickPost(url, f, publicDns);
    expect(urls).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/open the url in a browser instead/i);
  });

  it("refuses a hostname when any of its addresses is private", async () => {
    const { f, urls } = recordingFetch();
    const dns = async () => [{ address: "93.184.215.14", family: 4 }, { address: "192.168.1.1", family: 4 }];
    const r = await oneClickPost("https://router.example/u", f, dns);
    expect(urls).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("192.168.1.1");
    expect(r.detail).toMatch(/open the url in a browser instead/i);
  });

  it("refuses a hostname that resolves to an IPv6 unique local address", async () => {
    const { f, urls } = recordingFetch();
    const r = await oneClickPost("https://nas.example/u", f, async () => [{ address: "fd00::10", family: 6 }]);
    expect(urls).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it("refuses when the hostname cannot be resolved", async () => {
    const { f, urls } = recordingFetch();
    const dns = async () => { throw new Error("getaddrinfo ENOTFOUND nowhere.example"); };
    const r = await oneClickPost("https://nowhere.example/u", f, dns);
    expect(urls).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("ENOTFOUND");
    expect(r.detail).toMatch(/open the url in a browser instead/i);
  });

  it("refuses a URL whose host cannot be parsed", async () => {
    const { f, urls } = recordingFetch();
    const r = await oneClickPost("https://[zz]/u", f, publicDns);
    expect(urls).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it("posts to a public hostname after resolving that hostname", async () => {
    const { f, urls } = recordingFetch();
    const asked: string[] = [];
    const dns = async (host: string) => { asked.push(host); return publicDns(); };
    const r = await oneClickPost("https://Example.com:8443/u?t=1", f, dns);
    expect(asked).toEqual(["example.com"]);
    expect(urls).toEqual(["https://Example.com:8443/u?t=1"]);
    expect(r.ok).toBe(true);
  });

  it.each([
    "https://1.1.1.1/u",
    "https://172.32.0.1/u",
    "https://[2606:4700:4700::1111]/u",
  ])("posts to the public address %s", async (url) => {
    const { f, urls } = recordingFetch();
    const r = await oneClickPost(url, f, publicDns);
    expect(urls).toEqual([url]);
    expect(r.ok).toBe(true);
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
    expect(buildMailtoUrl({ oneClick: false, mailto: "stop@x.example", mailtoSubject: "Unsub me & go", mailtoBody: "a b\nc" }))
      .toBe("mailto:stop@x.example?subject=Unsub%20me%20%26%20go&body=a%20b%0Ac");
  });
  it("carries only address, subject and body from a hostile header", () => {
    const info = parseListUnsubscribe([{ name: "List-Unsubscribe", value: "<mailto:stop@x.example?cc=victim@y.example&bcc=v2@y.example&to=v3@y.example&subject=s>" }]);
    const url = buildMailtoUrl(info)!;
    expect(url).toBe("mailto:stop@x.example?subject=s");
  });
  it("encodes an address that tries to smuggle a query", () => {
    expect(buildMailtoUrl({ oneClick: false, mailto: "a@x.example?cc=v@y.example" })).not.toContain("?cc=");
  });
  it("caps subject at 200 characters and body at 1000", () => {
    const url = buildMailtoUrl({ oneClick: false, mailto: "stop@x.example", mailtoSubject: "s".repeat(500), mailtoBody: "b".repeat(5000) })!;
    const q = new URLSearchParams(url.split("?")[1]);
    expect(q.get("subject")).toHaveLength(200);
    expect(q.get("body")).toHaveLength(1000);
  });
});
