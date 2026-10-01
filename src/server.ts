import { McpServer } from "@modelcontextprotocol/server";
import { getAccessToken } from "./auth.js";
import { VERSION } from "./constants.js";
import { GraphClient } from "./graph.js";
import { MailService } from "./mail.js";
import { registerActionTools } from "./tools/actions.js";
import { registerFolderTools } from "./tools/folders.js";
import { registerMessageTools } from "./tools/messages.js";

export function buildServer(mail?: MailService): McpServer {
  const service = mail ?? new MailService(new GraphClient({ getToken: getAccessToken }));
  const server = new McpServer({ name: "mail-mcp", version: VERSION });
  registerFolderTools(server, service);
  registerMessageTools(server, service);
  registerActionTools(server, service);
  return server;
}
