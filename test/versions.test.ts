import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));

const TOOLS = [
  "mail_list_folders",
  "mail_create_folder",
  "mail_search",
  "mail_get_message",
  "mail_senders_summary",
  "mail_move",
  "mail_delete",
  "mail_bulk_by_sender",
  "mail_unsubscribe",
  "mail_login",
  "mail_logout",
];

describe("release metadata", () => {
  const pkg = read("package.json");
  const server = read("server.json");
  const manifest = read("mcpb/manifest.json");

  it("keeps every version in step with package.json", () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].version).toBe(pkg.version);
    expect(manifest.version).toBe(pkg.version);
  });

  it("lists exactly the server's tools in the bundle manifest", () => {
    const names = manifest.tools.map((t: { name: string }) => t.name);
    expect([...names].sort()).toEqual([...TOOLS].sort());
  });

  it("maps the optional client id user setting to MAIL_MCP_CLIENT_ID", () => {
    expect(manifest.server.mcp_config.env).toEqual({
      MAIL_MCP_CLIENT_ID: "${user_config.client_id}",
    });
  });
});
