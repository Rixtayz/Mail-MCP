import { describe, expect, it } from "vitest";
import { bodyToText, cleanPreview, truncate } from "../src/format.js";

describe("cleanPreview", () => {
  it("removes zero-width and filler characters and collapses whitespace", () => {
    expect(cleanPreview("Hello \u200c \u200c ͏ ͏ \u034f world\n\n!")).toBe("Hello world !");
  });
  it("caps length", () => {
    expect(cleanPreview("a".repeat(300)).length).toBe(200);
  });
});

describe("bodyToText", () => {
  it("converts html to text and skips images/styles", () => {
    const t = bodyToText({ contentType: "html", content: "<style>x{}</style><h1>Hi</h1><p>There <img src='x'></p>" });
    expect(t).toContain("Hi");
    expect(t).toContain("There");
    expect(t).not.toContain("x{}");
  });
  it("passes text through", () => {
    expect(bodyToText({ contentType: "text", content: "plain" })).toBe("plain");
  });
});

describe("truncate", () => {
  it("marks truncation", () => {
    const r = truncate("abcdef", 3);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("abc")).toBe(true);
    expect(truncate("ab", 3)).toEqual({ text: "ab", truncated: false });
  });
});
