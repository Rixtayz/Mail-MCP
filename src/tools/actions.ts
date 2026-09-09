import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ActionOutcome, MailService } from "../mail.js";
import { ok, run } from "./shared.js";

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

const Ids = z.array(z.string().min(1)).min(1).max(500).describe("Message ids (1 to 500)");

export function registerActionTools(server: McpServer, mail: MailService): void {
  server.registerTool(
    "mail_move",
    {
      title: "Move messages",
      description:
        "Move one or more messages (up to 500 ids) to a folder (name, path or id). Used for filing. " +
        "NOTE: Outlook assigns a new id to every moved message; the `moved` result maps old id → new id. " +
        "To move every message from a sender, prefer mail_bulk_by_sender.",
      inputSchema: z.object({ ids: Ids, folder: z.string().min(1).describe("Destination folder") }).strict(),
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
        "Delete one or more messages (up to 500 ids). By default messages go to Deleted Items (recoverable with mail_search folder=deleteditems then mail_move; their id changes). " +
        "`permanent: true` deletes irreversibly: only use it when the user explicitly asks for it.",
      inputSchema: z
        .object({
          ids: Ids,
          permanent: z.boolean().default(false).describe("true = permanent deletion (irreversible). Default: Deleted Items."),
        })
        .strict(),
      outputSchema: OutcomeSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ ids, permanent }) =>
      run(async () => {
        const outcomes = await mail.delete(ids, permanent);
        mail.invalidateSummaries();
        const s = summarizeOutcomes(outcomes, permanent ? "permanently deleted" : "moved to Deleted Items");
        return ok(s.text, s.structured);
      }),
  );

  server.registerTool(
    "mail_bulk_by_sender",
    {
      title: "Bulk action by sender",
      description:
        "Move or delete EVERY message from a sender (exact address) in a folder (Inbox by default). " +
        "Use `dryRun: true` first to learn how many messages match. Deletion goes to Deleted Items unless `permanent: true`.",
      inputSchema: z
        .object({
          from: z.string().email().describe("Exact sender address"),
          folder: z.string().optional().describe("Source folder. Default: inbox"),
          action: z.enum(["move", "delete"]).describe("move = move to targetFolder; delete = delete"),
          targetFolder: z.string().optional().describe("Required when action = move"),
          permanent: z.boolean().default(false).describe("With action = delete: permanent deletion"),
          dryRun: z.boolean().default(false).describe("true = count only, change nothing"),
        })
        .strict(),
      outputSchema: z.object({ matched: z.number(), dryRun: z.boolean(), succeeded: z.number(), failed: z.array(z.object({ id: z.string(), error: z.string() })) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ from, folder, action, targetFolder, permanent, dryRun }) =>
      run(async () => {
        if (action === "move" && !targetFolder) throw new Error("`targetFolder` is required when action = move.");
        const ids = await mail.idsFromSender(from, folder);
        if (dryRun || ids.length === 0) {
          return ok(`${ids.length} message(s) from ${from} in "${folder ?? "inbox"}".${dryRun ? " Nothing changed (dryRun)." : ""}`, { matched: ids.length, dryRun, succeeded: 0, failed: [] });
        }
        const outcomes = action === "move" ? await mail.move(ids, targetFolder!) : await mail.delete(ids, permanent);
        mail.invalidateSummaries();
        const verb = action === "move" ? `moved to "${targetFolder}"` : permanent ? "permanently deleted" : "moved to Deleted Items";
        const s = summarizeOutcomes(outcomes, verb);
        return ok(`${ids.length} message(s) from ${from}: ${s.text}`, { matched: ids.length, dryRun: false, ...s.structured });
      }),
  );

  server.registerTool(
    "mail_unsubscribe",
    {
      title: "Unsubscribe",
      description:
        "Try to unsubscribe from the mailing list of a message, in order: (1) RFC 8058 one-click HTTPS POST, (2) automatic email to the List-Unsubscribe mailto address, " +
        "(3) otherwise returns `method: \"browser\"` with the URL to open in a browser to finish manually, (4) `method: \"none\"` when no header exists. " +
        "Deletes nothing. Preferably pass the `lastMessageId` returned by mail_senders_summary.",
      inputSchema: z.object({ id: z.string().min(1).describe("Id of a representative message of the newsletter") }).strict(),
      outputSchema: z.object({
        method: z.enum(["one-click", "mailto", "browser", "none"]),
        ok: z.boolean(),
        url: z.string().optional(),
        mailto: z.string().optional(),
        detail: z.string(),
        from: z.string(),
        subject: z.string(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ id }) =>
      run(async () => {
        const r = await mail.unsubscribe(id);
        const head = r.ok ? `✅ Unsubscribed from ${r.from} (${r.method}).` : r.method === "browser" ? `🌐 Browser action required for ${r.from}: ${r.url}` : `⚠️ ${r.from}: ${r.method}`;
        return ok(`${head}\n${r.detail}`, { ...r });
      }),
  );
}
