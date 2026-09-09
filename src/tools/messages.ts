import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { messagesToMarkdown } from "../format.js";
import type { MailService } from "../mail.js";
import { ok, run } from "./shared.js";

const SummarySchema = z.object({
  id: z.string(),
  from: z.string(),
  fromName: z.string(),
  subject: z.string(),
  receivedDateTime: z.string(),
  isRead: z.boolean(),
  preview: z.string(),
});

const UnsubscribeSchema = z.object({
  https: z.string().optional(),
  mailto: z.string().optional(),
  mailtoSubject: z.string().optional(),
  mailtoBody: z.string().optional(),
  oneClick: z.boolean(),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:]+(\.\d+)?Z?)?$/, "ISO date expected, e.g. 2025-01-31 or 2025-01-31T00:00:00Z");

function normalizeDate(d: string | undefined): string | undefined {
  if (!d) return undefined;
  return d.length === 10 ? `${d}T00:00:00Z` : d.endsWith("Z") ? d : `${d}Z`;
}

export function registerMessageTools(server: McpServer, mail: MailService): void {
  server.registerTool(
    "mail_search",
    {
      title: "Search messages",
      description:
        "List messages of a folder (Inbox by default), newest first, with filters: exact sender, date range, unread only. " +
        "`query` runs a full-text search (subject, body, sender) and cannot be combined with the other filters. " +
        "Returns a compact summary (id, sender, subject, date, preview); use mail_get_message for the full content. " +
        "To page, pass `cursor` back verbatim. For a whole-mailbox view by sender, prefer mail_senders_summary.",
      inputSchema: z
        .object({
          folder: z.string().optional().describe("Folder (name, path, well-known name or id). Default: inbox"),
          from: z.string().optional().describe("Exact sender address, e.g. news@example.com"),
          since: isoDate.optional().describe("Received on or after this date (ISO)"),
          until: isoDate.optional().describe("Received on or before this date (ISO)"),
          unreadOnly: z.boolean().optional().describe("Only unread messages"),
          query: z.string().optional().describe("Full-text search (simple KQL). Exclusive with from/since/until/unreadOnly."),
          limit: z.number().int().min(1).max(100).default(25).describe("Results per page (max 100)"),
          cursor: z.string().optional().describe("Page cursor returned by a previous call"),
        })
        .strict(),
      outputSchema: z.object({ items: z.array(SummarySchema), count: z.number(), nextCursor: z.string().optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (p) =>
      run(async () => {
        if (p.query && (p.from || p.since || p.until || p.unreadOnly)) {
          throw new Error("`query` cannot be combined with from/since/until/unreadOnly (Microsoft Graph limitation). Make two calls.");
        }
        const r = await mail.search({
          folder: p.folder,
          from: p.from,
          since: normalizeDate(p.since),
          until: normalizeDate(p.until),
          unreadOnly: p.unreadOnly,
          query: p.query,
          limit: p.limit,
          cursor: p.cursor,
        });
        const text = messagesToMarkdown(r.items) + (r.nextCursor ? `\n\n_More results available: pass \`cursor\` back._` : "");
        return ok(text, { items: r.items, count: r.items.length, ...(r.nextCursor ? { nextCursor: r.nextCursor } : {}) });
      }),
  );

  server.registerTool(
    "mail_get_message",
    {
      title: "Read a message",
      description:
        "Return the full content of one message (body converted to text, recipients, attachment flag, web link) " +
        "plus the unsubscribe options found in its headers (https, mailto, one-click). The body is truncated at 25,000 characters.",
      inputSchema: z.object({ id: z.string().min(1).describe("Message id (from mail_search or mail_senders_summary)") }).strict(),
      outputSchema: z.object({
        message: SummarySchema,
        to: z.array(z.string()),
        body: z.string(),
        truncated: z.boolean(),
        hasAttachments: z.boolean(),
        webLink: z.string().optional(),
        unsubscribe: UnsubscribeSchema,
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) =>
      run(async () => {
        const r = await mail.getMessage(id);
        const u = r.unsubscribe;
        const unsubLine = u.oneClick
          ? `One-click unsubscribe available (${u.https})`
          : u.mailto || u.https
            ? `Unsubscribe: ${u.https ? "URL " + u.https : ""}${u.https && u.mailto ? " / " : ""}${u.mailto ? "mailto " + u.mailto : ""}`
            : "No unsubscribe header";
        const text =
          `**${r.summary.subject}**\nFrom: ${r.summary.fromName} <${r.summary.from}>\nTo: ${r.to.join(", ")}\nReceived: ${r.summary.receivedDateTime}\n` +
          `${r.hasAttachments ? "Attachments: yes\n" : ""}${unsubLine}\n\n---\n${r.body}`;
        return ok(text, { message: r.summary, to: r.to, body: r.body, truncated: r.truncated, hasAttachments: r.hasAttachments, ...(r.webLink ? { webLink: r.webLink } : {}), unsubscribe: u });
      }),
  );

  server.registerTool(
    "mail_senders_summary",
    {
      title: "Summary by sender",
      description:
        "KEY TOOL FOR TRIAGE. Scans a whole folder (Inbox by default) and aggregates messages by sender: count, unread, latest message, " +
        "and for the `top` senders the available unsubscribe method (oneClick / https / mailto). Sorted by volume. " +
        "The scan is cached for the session. Follow up with mail_unsubscribe(lastMessageId) and mail_bulk_by_sender(address).",
      inputSchema: z
        .object({
          folder: z.string().optional().describe("Folder to analyse. Default: inbox"),
          since: isoDate.optional().describe("Only count messages received since this date"),
          top: z.number().int().min(1).max(200).default(50).describe("Number of senders to return (max 200)"),
        })
        .strict(),
      outputSchema: z.object({
        scanned: z.number(),
        totalSenders: z.number(),
        senders: z.array(
          z.object({
            address: z.string(),
            name: z.string(),
            domain: z.string(),
            count: z.number(),
            unreadCount: z.number(),
            lastReceived: z.string(),
            lastSubject: z.string(),
            lastMessageId: z.string(),
            unsubscribe: UnsubscribeSchema.optional(),
          }),
        ),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ folder, since, top }) =>
      run(async () => {
        const r = await mail.sendersSummary(folder, normalizeDate(since), top);
        const lines = r.senders.map((s, i) => {
          const u = s.unsubscribe;
          const method = u?.oneClick ? "one-click" : u?.mailto ? "mailto" : u?.https ? "browser" : "none";
          return `${i + 1}. ${s.name ? s.name + " " : ""}<${s.address}> — ${s.count} msgs (${s.unreadCount} unread), latest ${s.lastReceived.slice(0, 10)} "${s.lastSubject}" | unsubscribe: ${method} | lastMessageId: \`${s.lastMessageId}\``;
        });
        const text = `${r.scanned} messages scanned, ${r.totalSenders} senders. Top ${r.senders.length}:\n${lines.join("\n")}`;
        return ok(text, r);
      }),
  );
}
