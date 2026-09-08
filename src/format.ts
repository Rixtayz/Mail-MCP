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

export function summarizeMessage(m: GraphMessage): MessageSummary {
  return {
    id: m.id,
    from: m.from?.emailAddress?.address?.toLowerCase() ?? "",
    fromName: m.from?.emailAddress?.name ?? "",
    subject: m.subject ?? "(sans objet)",
    receivedDateTime: m.receivedDateTime ?? "",
    isRead: m.isRead ?? false,
    preview: (m.bodyPreview ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
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
