import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { ActionOutcome, MailService } from "../mail.js";
import { ok, run } from "./shared.js";

const OutcomeSchema = z.object({
  succeeded: z.number(),
  failed: z.array(z.object({ id: z.string(), error: z.string() })),
});

function summarizeOutcomes(outcomes: ActionOutcome[], verb: string) {
  const failed = outcomes.filter((o) => !o.ok).map((o) => ({ id: o.id, error: o.error ?? "inconnu" }));
  const succeeded = outcomes.length - failed.length;
  const text = `${succeeded} message(s) ${verb}.` + (failed.length ? ` ${failed.length} échec(s) : ${failed.map((f) => `${f.id.slice(0, 12)}… (${f.error})`).join(", ")}` : "");
  return { text, structured: { succeeded, failed } };
}

const Ids = z.array(z.string().min(1)).min(1).max(500).describe("Ids de messages (1 à 500)");

export function registerActionTools(server: McpServer, mail: MailService): void {
  server.registerTool(
    "mail_move",
    {
      title: "Déplacer des messages",
      description:
        "Déplace un ou plusieurs messages (jusqu'à 500 ids) vers un dossier (nom, chemin ou id). Utilisé pour classer. " +
        "Pour déplacer tous les messages d'un expéditeur, préférez mail_bulk_by_sender.",
      inputSchema: z.object({ ids: Ids, folder: z.string().min(1).describe("Dossier de destination") }).strict(),
      outputSchema: OutcomeSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ ids, folder }) =>
      run(async () => {
        const outcomes = await mail.move(ids, folder);
        mail.invalidateSummaries();
        const s = summarizeOutcomes(outcomes, `déplacé(s) vers « ${folder} »`);
        return ok(s.text, s.structured);
      }),
  );

  server.registerTool(
    "mail_delete",
    {
      title: "Supprimer des messages",
      description:
        "Supprime un ou plusieurs messages (jusqu'à 500 ids). Par défaut les messages vont dans Éléments supprimés (récupérable). " +
        "`permanent: true` supprime définitivement : à n'utiliser que sur demande explicite de l'utilisateur.",
      inputSchema: z
        .object({
          ids: Ids,
          permanent: z.boolean().default(false).describe("true = suppression définitive (irréversible). Défaut : corbeille."),
        })
        .strict(),
      outputSchema: OutcomeSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ ids, permanent }) =>
      run(async () => {
        const outcomes = await mail.delete(ids, permanent);
        mail.invalidateSummaries();
        const s = summarizeOutcomes(outcomes, permanent ? "supprimé(s) définitivement" : "mis à la corbeille");
        return ok(s.text, s.structured);
      }),
  );

  server.registerTool(
    "mail_bulk_by_sender",
    {
      title: "Action en masse par expéditeur",
      description:
        "Déplace ou supprime TOUS les messages d'un expéditeur (adresse exacte) dans un dossier (Inbox par défaut). " +
        "Utilisez `dryRun: true` d'abord pour connaître le nombre de messages concernés. La suppression va à la corbeille sauf si `permanent: true`.",
      inputSchema: z
        .object({
          from: z.string().email().describe("Adresse exacte de l'expéditeur"),
          folder: z.string().optional().describe("Dossier source. Défaut : inbox"),
          action: z.enum(["move", "delete"]).describe("move = déplacer vers targetFolder ; delete = supprimer"),
          targetFolder: z.string().optional().describe("Obligatoire si action = move"),
          permanent: z.boolean().default(false).describe("Avec action = delete : suppression définitive"),
          dryRun: z.boolean().default(false).describe("true = compter seulement, ne rien modifier"),
        })
        .strict(),
      outputSchema: z.object({ matched: z.number(), dryRun: z.boolean(), succeeded: z.number(), failed: z.array(z.object({ id: z.string(), error: z.string() })) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ from, folder, action, targetFolder, permanent, dryRun }) =>
      run(async () => {
        if (action === "move" && !targetFolder) throw new Error("`targetFolder` est obligatoire avec action = move.");
        const ids = await mail.idsFromSender(from, folder);
        if (dryRun || ids.length === 0) {
          return ok(`${ids.length} message(s) de ${from} dans « ${folder ?? "inbox"} ».${dryRun ? " Aucune modification (dryRun)." : ""}`, { matched: ids.length, dryRun, succeeded: 0, failed: [] });
        }
        const outcomes = action === "move" ? await mail.move(ids, targetFolder!) : await mail.delete(ids, permanent);
        mail.invalidateSummaries();
        const verb = action === "move" ? `déplacé(s) vers « ${targetFolder} »` : permanent ? "supprimé(s) définitivement" : "mis à la corbeille";
        const s = summarizeOutcomes(outcomes, verb);
        return ok(`${ids.length} message(s) de ${from} : ${s.text}`, { matched: ids.length, dryRun: false, ...s.structured });
      }),
  );

  server.registerTool(
    "mail_unsubscribe",
    {
      title: "Se désabonner",
      description:
        "Tente de se désabonner de la liste d'un message, dans l'ordre : (1) un-clic RFC 8058 par POST HTTPS, (2) courriel automatique à l'adresse mailto de List-Unsubscribe, " +
        "(3) sinon retourne `method: \"browser\"` avec l'URL à ouvrir dans le navigateur pour finir manuellement, (4) `method: \"none\"` si aucun en-tête. " +
        "Ne supprime aucun message. Passez de préférence le `lastMessageId` fourni par mail_senders_summary.",
      inputSchema: z.object({ id: z.string().min(1).describe("Id du message représentatif de la newsletter") }).strict(),
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
        const head = r.ok ? `✅ Désabonné de ${r.from} (${r.method}).` : r.method === "browser" ? `🌐 Action navigateur requise pour ${r.from} : ${r.url}` : `⚠️ ${r.from} : ${r.method}`;
        return ok(`${head}\n${r.detail}`, { ...r });
      }),
  );
}
