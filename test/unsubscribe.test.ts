import { describe, expect, it } from "vitest";
import { oneClickPost, parseListUnsubscribe, splitListUnsubscribe } from "../src/unsubscribe.js";

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

describe("oneClickPost", () => {
  const mk = (status: number) => (async () => new Response(null, { status })) as unknown as typeof fetch;

  it("succeeds on 2xx and sends the exact body without following redirects", async () => {
    let captured: RequestInit | undefined;
    const f = (async (_u: string, init?: RequestInit) => {
      captured = init;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await oneClickPost("https://x.example/u", f);
    expect(r.ok).toBe(true);
    expect(captured?.method).toBe("POST");
    expect(captured?.body).toBe("List-Unsubscribe=One-Click");
    expect(captured?.redirect).toBe("manual");
  });

  it("treats redirects as failure", async () => {
    const r = await oneClickPost("https://x.example/u", mk(302));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(302);
  });

  it("treats network errors as failure without throwing", async () => {
    const f = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    const r = await oneClickPost("https://x.example/u", f);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("ECONNRESET");
  });
});
