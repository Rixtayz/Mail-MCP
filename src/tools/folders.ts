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
      title: "List folders",
      description:
        "List every folder of the Outlook.com mailbox with its path, total message count and unread count. " +
        "Call it before filing messages to learn which folders exist. Other tools accept a folder by display name (\"Invoices\"), " +
        "by path (\"Archive/2024\"), by well-known name (inbox, deleteditems, junkemail, archive) or by id.",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({ folders: z.array(FolderSchema) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      run(async () => {
        const folders = await mail.listFolders(true);
        const text = folders.map((f) => `- ${f.path} (${f.total} messages, ${f.unread} unread)${f.wellKnownName ? ` [${f.wellKnownName}]` : ""}`).join("\n");
        return ok(text || "_No folders._", { folders });
      }),
  );

  server.registerTool(
    "mail_create_folder",
    {
      title: "Create folder",
      description:
        "Create an Outlook folder (at the root or under a parent). Idempotent: if a folder with the same name already exists it is returned without error. " +
        "Example: { name: \"Newsletters\" } or { name: \"2025\", parent: \"Invoices\" }.",
      inputSchema: z
        .object({
          name: z.string().min(1).max(100).describe("Name of the folder to create"),
          parent: z.string().optional().describe("Parent folder (name, path or id). Root if omitted."),
        })
        .strict(),
      outputSchema: z.object({ folder: FolderSchema, created: z.boolean() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, parent }) =>
      run(async () => {
        const r = await mail.createFolder(name, parent);
        const text = r.created ? `Folder created: ${r.folder.path} (id ${r.folder.id})` : `Folder already exists: ${r.folder.path} (id ${r.folder.id})`;
        return ok(text, { folder: r.folder, created: r.created });
      }),
  );
}
