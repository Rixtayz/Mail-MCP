import { afterEach, describe, expect, it } from "vitest";
import { clientId } from "../src/auth.js";

describe("clientId", () => {
  const OWN = "11111111-2222-3333-4444-555555555555";
  afterEach(() => { delete process.env.MAIL_MCP_CLIENT_ID; });
  it.each([undefined, "", "   ", "${user_config.client_id}"])("falls back to the built-in ID for %j", (value) => {
    if (value === undefined) delete process.env.MAIL_MCP_CLIENT_ID; else process.env.MAIL_MCP_CLIENT_ID = value;
    expect(clientId()).toBe("599bb072-c4e2-42b1-b4e5-1d901fc08c66");
  });
  it("uses the user's own ID, trimmed", () => {
    process.env.MAIL_MCP_CLIENT_ID = ` ${OWN} `;
    expect(clientId()).toBe(OWN);
  });
});
