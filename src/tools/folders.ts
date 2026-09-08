import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { MailService } from "../mail.js";
import { ok, run } from "./shared.js";

const FolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  parentId: z.string().optional(),
  total: z.number(),
  unread: z.number(),
  wellKnownName: z.string().optional(),
});

export function registerFolderTools(server: McpServer, mail: MailService): void {
  server.registerTool(
    "mail_list_folders",
    {
      title: "Lister les dossiers",
      description:
        "Liste tous les dossiers de la boîte Outlook.com avec leur chemin, le nombre total de messages et le nombre de non lus. " +
        "À appeler avant de classer pour connaître les dossiers existants. Les autres outils acceptent un dossier par nom (« Factures »), " +
        "par chemin (« Archive/2024 »), par nom bien connu (inbox, deleteditems, junkemail, archive) ou par id.",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ folders: z.array(FolderSchema) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      run(async () => {
        const folders = await mail.listFolders(true);
        const text = folders.map((f) => `- ${f.path} (${f.total} messages, ${f.unread} non lus)${f.wellKnownName ? ` [${f.wellKnownName}]` : ""}`).join("\n");
        return ok(text || "_Aucun dossier._", { folders });
      }),
  );

  server.registerTool(
    "mail_create_folder",
    {
      title: "Créer un dossier",
      description:
        "Crée un dossier Outlook (à la racine ou sous un dossier parent). Idempotent : si un dossier du même nom existe déjà, il est retourné sans erreur. " +
        "Exemple : { name: \"Newsletters\" } ou { name: \"2025\", parent: \"Factures\" }.",
      inputSchema: z
        .object({
          name: z.string().min(1).max(100).describe("Nom du dossier à créer"),
          parent: z.string().optional().describe("Dossier parent (nom, chemin ou id). Racine si omis."),
        })
        .strict(),
      outputSchema: z.object({ folder: FolderSchema, created: z.boolean() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, parent }) =>
      run(async () => {
        const r = await mail.createFolder(name, parent);
        const text = r.created ? `Dossier créé : ${r.folder.path} (id ${r.folder.id})` : `Dossier déjà existant : ${r.folder.path} (id ${r.folder.id})`;
        return ok(text, { folder: r.folder, created: r.created });
      }),
  );
}
