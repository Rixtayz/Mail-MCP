import { htmlToText } from "html-to-text";
import { CHARACTER_LIMIT } from "./constants.js";
import type { GraphMessage } from "./types.js";

/** Compact one-line summary of a message for lists. */
export interface MessageSummary {
  id: string;
  from: string;
  fromName: string;
  subject: string;
  receivedDateTime: string;
  isRead: boolean;
  preview: string;
}

/** Strip invisible filler characters newsletters use for preview padding, collapse whitespace. */
export function cleanPreview(text: string, max = 200): string {
  return text
    .replace(/[\u00AD\u034F\u061C\u180E\u200B-\u200F\u2028-\u202F\u205F-\u206F\u2800\u3164\uFEFF\uFFA0]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function summarizeMessage(m: GraphMessage): MessageSummary {
  return {
    id: m.id,
    from: m.from?.emailAddress?.address?.toLowerCase() ?? "",
    fromName: m.from?.emailAddress?.name ?? "",
    subject: m.subject ?? "(sans objet)",
    receivedDateTime: m.receivedDateTime ?? "",
    isRead: m.isRead ?? false,
    preview: cleanPreview(m.bodyPreview ?? ""),
  };
}

/** Convert a Graph body (html or text) to readable plain text. */
export function bodyToText(body: GraphMessage["body"]): string {
  if (!body?.content) return "";
  if (body.contentType !== "html") return body.content;
  return htmlToText(body.content, {
    wordwrap: false,
    selectors: [
      { selector: "img", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "h1", options: { uppercase: false } },
      { selector: "h2", options: { uppercase: false } },
      { selector: "h3", options: { uppercase: false } },
      { selector: "a", options: { ignoreHref: false, hideLinkHrefIfSameAsText: true } },
    ],
  })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Truncate text to the character limit, appending a marker when cut. */
export function truncate(text: string, limit = CHARACTER_LIMIT): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit) + "\n\n[... tronqué]", truncated: true };
}

/** Render a list of message summaries as compact markdown. */
export function messagesToMarkdown(items: MessageSummary[]): string {
  if (items.length === 0) return "_Aucun message._";
  return items
    .map((m) => {
      const flag = m.isRead ? " " : "•";
      const date = m.receivedDateTime.slice(0, 16).replace("T", " ");
      const who = m.fromName ? `${m.fromName} <${m.from}>` : m.from;
      return `${flag} ${date} | ${who} | **${m.subject}** | id: \`${m.id}\`\n  ${m.preview}`;
    })
    .join("\n");
}
