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

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(T[\d:]+(\.\d+)?Z?)?$/, "Date ISO attendue, ex. 2025-01-31 ou 2025-01-31T00:00:00Z");

function normalizeDate(d: string | undefined): string | undefined {
  if (!d) return undefined;
  return d.length === 10 ? `${d}T00:00:00Z` : d.endsWith("Z") ? d : `${d}Z`;
}

export function registerMessageTools(server: McpServer, mail: MailService): void {
  server.registerTool(
    "mail_search",
    {
      title: "Chercher des messages",
      description:
        "Liste les messages d'un dossier (Inbox par défaut), du plus récent au plus ancien, avec filtres : expéditeur exact, période, non lus. " +
        "`query` fait une recherche plein texte (sujet, corps, expéditeur) et est exclusif avec les autres filtres. " +
        "Retour compact (id, expéditeur, sujet, date, aperçu) ; utilisez mail_get_message pour le contenu complet. " +
        "Pour parcourir, repassez `cursor` tel quel. Pour un tri par expéditeur sur toute la boîte, préférez mail_senders_summary.",
      inputSchema: z
        .object({
          folder: z.string().optional().describe("Dossier (nom, chemin, nom bien connu ou id). Défaut : inbox"),
          from: z.string().optional().describe("Adresse d'expéditeur exacte, ex. news@example.com"),
          since: isoDate.optional().describe("Reçus à partir de cette date (ISO)"),
          until: isoDate.optional().describe("Reçus jusqu'à cette date (ISO)"),
          unreadOnly: z.boolean().optional().describe("Seulement les non lus"),
          query: z.string().optional().describe("Recherche plein texte (KQL simple). Exclusif avec from/since/until/unreadOnly."),
          limit: z.number().int().min(1).max(100).default(25).describe("Nombre de résultats par page (max 100)"),
          cursor: z.string().optional().describe("Curseur de page renvoyé par un appel précédent"),
        })
        .strict(),
      outputSchema: z.object({ items: z.array(SummarySchema), count: z.number(), nextCursor: z.string().optional() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (p) =>
      run(async () => {
        if (p.query && (p.from || p.since || p.until || p.unreadOnly)) {
          throw new Error("`query` ne peut pas être combiné avec from/since/until/unreadOnly (limitation Microsoft Graph). Faites deux appels.");
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
        const text = messagesToMarkdown(r.items) + (r.nextCursor ? `\n\n_Page suivante disponible : repassez \`cursor\`._` : "");
        return ok(text, { items: r.items, count: r.items.length, ...(r.nextCursor ? { nextCursor: r.nextCursor } : {}) });
      }),
  );

  server.registerTool(
    "mail_get_message",
    {
      title: "Lire un message",
      description:
        "Retourne le contenu complet d'un message (corps converti en texte, destinataires, pièces jointes présentes, lien web) " +
        "et les informations de désabonnement détectées dans les en-têtes (https, mailto, un-clic). Le corps est tronqué à 25 000 caractères.",
      inputSchema: z.object({ id: z.string().min(1).describe("Id du message (issu de mail_search ou mail_senders_summary)") }).strict(),
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
          ? `Désabonnement un-clic disponible (${u.https})`
          : u.mailto || u.https
            ? `Désabonnement : ${u.https ? "URL " + u.https : ""}${u.https && u.mailto ? " / " : ""}${u.mailto ? "mailto " + u.mailto : ""}`
            : "Aucun en-tête de désabonnement";
        const text =
          `**${r.summary.subject}**\nDe : ${r.summary.fromName} <${r.summary.from}>\nÀ : ${r.to.join(", ")}\nReçu : ${r.summary.receivedDateTime}\n` +
          `${r.hasAttachments ? "Pièces jointes : oui\n" : ""}${unsubLine}\n\n---\n${r.body}`;
        return ok(text, { message: r.summary, to: r.to, body: r.body, truncated: r.truncated, hasAttachments: r.hasAttachments, ...(r.webLink ? { webLink: r.webLink } : {}), unsubscribe: u });
      }),
  );

  server.registerTool(
    "mail_senders_summary",
    {
      title: "Synthèse par expéditeur",
      description:
        "OUTIL CLÉ POUR LE TRI. Scanne tout un dossier (Inbox par défaut) et agrège les messages par expéditeur : nombre, non lus, dernier message, " +
        "et pour les `top` premiers, la méthode de désabonnement disponible (oneClick / https / mailto). Trié par volume décroissant. " +
        "Le scan est mis en cache pour la session. Utilisez ensuite mail_unsubscribe(lastMessageId) et mail_bulk_by_sender(address).",
      inputSchema: z
        .object({
          folder: z.string().optional().describe("Dossier à analyser. Défaut : inbox"),
          since: isoDate.optional().describe("Ne compter que les messages reçus depuis cette date"),
          top: z.number().int().min(1).max(200).default(50).describe("Nombre d'expéditeurs à retourner (max 200)"),
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
          const method = u?.oneClick ? "un-clic" : u?.mailto ? "mailto" : u?.https ? "navigateur" : "aucun";
          return `${i + 1}. ${s.name ? s.name + " " : ""}<${s.address}> — ${s.count} msgs (${s.unreadCount} non lus), dernier ${s.lastReceived.slice(0, 10)} « ${s.lastSubject} » | désabo: ${method} | lastMessageId: \`${s.lastMessageId}\``;
        });
        const text = `${r.scanned} messages scannés, ${r.totalSenders} expéditeurs. Top ${r.senders.length} :\n${lines.join("\n")}`;
        return ok(text, r);
      }),
  );
}
