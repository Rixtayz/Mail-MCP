import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { BULK_LIMIT, type ActionOutcome, type MailService } from "../mail.js";
import { MessageId, MessageIds, ok, run } from "./shared.js";

const BULK_LIMIT_TEXT = BULK_LIMIT.toLocaleString("en-US");
const CAPPED = `This sender has more than ${BULK_LIMIT_TEXT} messages in this folder, the most one call handles:`;

const OutcomeSchema = z.object({
  succeeded: z.number(),
  failed: z.array(z.object({ id: z.string(), error: z.string() })),
  moved: z.array(z.object({ id: z.string(), newId: z.string() })).optional(),
});

function summarizeOutcomes(outcomes: ActionOutcome[], verb: string) {
  const failed = outcomes.filter((o) => !o.ok).map((o) => ({ id: o.id, error: o.error ?? "unknown" }));
  const succeeded = outcomes.length - failed.length;
  const moved = outcomes.filter((o) => o.ok && o.newId).map((o) => ({ id: o.id, newId: o.newId! }));
  const text =
    `${succeeded} message(s) ${verb}.` +
    (failed.length ? ` ${failed.length} failure(s): ${failed.map((f) => `${f.id.slice(0, 12)}… (${f.error})`).join(", ")}` : "") +
    (moved.length ? " Ids changed (see `moved`): the old ids are no longer valid." : "");
  return { text, structured: { succeeded, failed, ...(moved.length ? { moved } : {}) } };
}

export function registerActionTools(server: McpServer, mail: MailService): void {
  server.registerTool(
    "mail_move",
    {
      title: "Move messages",
      description:
        "Move one or more messages (up to 500 ids) to a folder (name, path or id). Used for filing. " +
        "NOTE: Outlook assigns a new id to every moved message; the `moved` result maps old id → new id. " +
        "To move every message from a sender, prefer mail_bulk_by_sender.",
      inputSchema: z.object({ ids: MessageIds, folder: z.string().min(1).describe("Destination folder") }).strict(),
      outputSchema: OutcomeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ ids, folder }) =>
      run(async () => {
        const outcomes = await mail.move(ids, folder);
        mail.invalidateSummaries();
        const s = summarizeOutcomes(outcomes, `moved to "${folder}"`);
        return ok(s.text, s.structured);
      }),
  );

  server.registerTool(
    "mail_delete",
    {
      title: "Delete messages",
      description:
        "Move one or more messages (up to 500 ids) to Deleted Items, where the user can restore them from Outlook " +
        "(or with mail_search folder=deleteditems then mail_move; their id changes). Never deletes permanently: " +
        "for that, use mail_purge, and only when the user explicitly asks for permanent deletion.",
      inputSchema: z.object({ ids: MessageIds }).strict(),
      outputSchema: OutcomeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ ids }) =>
      run(async () => {
        const outcomes = await mail.delete(ids);
        mail.invalidateSummaries();
        const s = summarizeOutcomes(outcomes, "moved to Deleted Items");
        return ok(s.text, s.structured);
      }),
  );

  server.registerTool(
    "mail_purge",
    {
      title: "Permanently delete messages",
      description:
        "Permanently delete one or more messages (up to 500 ids). This cannot be undone: the messages do not go to Deleted Items " +
        "and cannot be restored. Only use it when the user explicitly asked for these messages to be deleted permanently; " +
        "otherwise use mail_delete, which moves them to Deleted Items.",
      inputSchema: z.object({ ids: MessageIds }).strict(),
      outputSchema: OutcomeSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ ids }) =>
      run(async () => {
        const outcomes = await mail.permanentDelete(ids);
        mail.invalidateSummaries();
        const s = summarizeOutcomes(outcomes, "permanently deleted");
        return ok(s.text, s.structured);
      }),
  );

  server.registerTool(
    "mail_bulk_by_sender",
    {
      title: "Bulk action by sender",
      description:
        "Move EVERY message from a sender (exact address) in a folder (Inbox by default) to another folder, or to Deleted Items, " +
        `at most ${BULK_LIMIT_TEXT} per call. A dry run by default: it only counts the messages it would act on (\`matched\`) and changes nothing. ` +
        "Tell the user that count and, once they confirm, call again with `dryRun: false`. " +
        `\`capped: true\` means the sender has more than ${BULK_LIMIT_TEXT} messages there: call again for the rest. ` +
        "Never deletes permanently (see mail_purge).",
      inputSchema: z
        .object({
          from: z.string().email().describe("Exact sender address"),
          folder: z.string().optional().describe("Source folder. Default: inbox"),
          action: z.enum(["move", "delete"]).describe("move = move to targetFolder; delete = move to Deleted Items"),
          targetFolder: z.string().optional().describe("Required when action = move"),
          dryRun: z.boolean().default(true).describe("Default true: count only, change nothing. false = act, once the user has confirmed."),
        })
        .strict(),
      outputSchema: z.object({
        matched: z.number().describe(`Messages acted on, or that would be with a dry run (at most ${BULK_LIMIT_TEXT})`),
        capped: z.boolean().describe(`true when the sender has more than ${BULK_LIMIT_TEXT} messages in the folder`),
        dryRun: z.boolean(),
        succeeded: z.number(),
        failed: z.array(z.object({ id: z.string(), error: z.string() })),
        moved: z.array(z.object({ id: z.string(), newId: z.string() })).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ from, folder, action, targetFolder, dryRun }) =>
      run(async () => {
        const r = await mail.bulkBySender({ from, folder, action, targetFolder, dryRun });
        const verb = action === "move" ? `moved to "${targetFolder}"` : "moved to Deleted Items";
        const where = `${r.matched} message(s) from ${from} in "${folder ?? "inbox"}"`;
        if (r.matched === 0) return ok(`${where}. Nothing to do.`, { matched: 0, capped: false, dryRun: r.dryRun, succeeded: 0, failed: [] });
        if (r.dryRun) {
          const cap = r.capped ? ` ${CAPPED} a run acts on ${BULK_LIMIT_TEXT} of them, then call again for the rest.` : "";
          return ok(`${where} would be ${verb}. Nothing changed (dry run): once the user confirms, call again with dryRun: false.${cap}`, {
            matched: r.matched,
            capped: r.capped,
            dryRun: true,
            succeeded: 0,
            failed: [],
          });
        }
        mail.invalidateSummaries();
        const s = summarizeOutcomes(r.outcomes, verb);
        const cap = r.capped ? ` ${CAPPED} call again for the rest.` : "";
        return ok(`${r.matched} message(s) from ${from}: ${s.text}${cap}`, { matched: r.matched, capped: r.capped, dryRun: false, ...s.structured });
      }),
  );

  server.registerTool(
    "mail_unsubscribe",
    {
      title: "Unsubscribe",
      description:
        "Try to unsubscribe from the mailing list of a message, in order: (1) RFC 8058 one-click HTTPS POST (`method: \"one-click\"`, done); " +
        "(2) otherwise `method: \"browser\"` with the https URL to open in a browser, plus `mailtoUrl` when the sender also lists an email address; " +
        "(3) `method: \"mailto\"` when email is the only usable way (no link, or only a plain http link, which is never opened): " +
        "`mailtoUrl` is a link that opens a pre-filled message in the user's own mail app, and the user presses Send; " +
        "(4) `method: \"blocked\"` when the link points to this computer or the local network, could not be checked, or is plain http with no email address to use instead: " +
        "nothing was opened and no link is returned; tell the user what `detail` says, and treat a link to the local network as a sign of a suspicious message; " +
        "(5) `method: \"none\"` when no header exists. This tool never sends email. " +
        "Deletes nothing. Preferably pass the `lastMessageId` returned by mail_senders_summary.",
      inputSchema: z.object({ id: MessageId.describe("Id of a representative message of the newsletter") }).strict(),
      outputSchema: z.object({
        method: z.enum(["one-click", "mailto", "browser", "blocked", "none"]),
        ok: z.boolean(),
        url: z.string().optional(),
        mailto: z.string().optional(),
        mailtoUrl: z.string().optional(),
        detail: z.string(),
        from: z.string(),
        subject: z.string(),
      }),
      // Destructive: unsubscribing acts at the sender, and Mail-MCP cannot undo it.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ id }) =>
      run(async () => {
        const r = await mail.unsubscribe(id);
        const head = r.ok
          ? `✅ Unsubscribed from ${r.from} (${r.method}).`
          : r.method === "browser"
            ? `🌐 Browser action required for ${r.from}: ${r.url}`
            : r.method === "mailto"
              ? `✉️ Email needed for ${r.from}: ${r.mailtoUrl}`
              : r.method === "blocked"
                ? `⛔ Unsubscribe link blocked for ${r.from}.`
                : `⚠️ ${r.from}: ${r.method}`;
        return ok(`${head}\n${r.detail}`, { ...r });
      }),
  );
}
