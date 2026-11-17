import type { McpServer } from "@modelcontextprotocol/server";
import open from "open";
import * as z from "zod/v4";
import { loginInteractive, logout, signedInAccount } from "../auth.js";
import { CONSENT_URL, LOGIN_GIVE_UP_MS, LOGIN_WAIT_MS } from "../constants.js";
import { LoginFlow, cancelLoopback, type LoginStatus } from "../session.js";
import { ok, run } from "./shared.js";

export interface SessionService {
  login(): Promise<LoginStatus>;
  logout(): Promise<{ account?: string }>;
}

/**
 * The real service. Each call makes its own LoginFlow, and buildServer() calls it once per server,
 * so overlapping mail_login calls to one server share a single browser sign-in.
 */
export function createSessionService(): SessionService {
  const flow = new LoginFlow({
    signedInAccount,
    loginInteractive,
    // `open` never waits for the browser itself. It resolves once the launcher has started, or on Windows once
    // the PowerShell launcher has exited, which it does as soon as it has started the browser.
    openBrowser: async (url) => {
      await open(url);
    },
    cancel: (authUrl) => cancelLoopback(authUrl),
    waitMs: LOGIN_WAIT_MS,
    giveUpMs: LOGIN_GIVE_UP_MS,
  });
  return { login: () => flow.start(), logout };
}

/** The text a logout reports, shared by the mail_logout tool and `mail-mcp logout`. */
export function logoutDetail(account: string | undefined): string {
  return account === undefined
    ? `No account was signed in. To withdraw Mail-MCP's access on Microsoft's side, the user can open ${CONSENT_URL}.`
    : `Signed out of ${account}. The local sign-in was removed. To also withdraw Mail-MCP's access on Microsoft's side, the user can open ${CONSENT_URL}.`;
}

export function registerSessionTools(server: McpServer, session: SessionService): void {
  server.registerTool(
    "mail_login",
    {
      title: "Sign in to Outlook",
      description:
        "Sign the user in to their personal Outlook mailbox. Call it when any other tool answers \"Not signed in\" or that the sign-in has expired. " +
        "It opens a Microsoft sign-in page in the user's browser and waits for them to finish. If the result is \"pending\", ask the user to complete the sign-in in their browser, then call mail_login again. " +
        "It asks for access to read and organize mail only: it never asks for permission to send email. Safe to call when already signed in.",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        status: z.enum(["signed_in", "pending", "failed"]),
        account: z.string().optional(),
        url: z.string().optional(),
        detail: z.string(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () =>
      run(async () => {
        const r = await session.login();
        if (r.status === "signed_in") {
          const detail = `Signed in as ${r.account}.`;
          return ok(detail, { status: "signed_in", account: r.account, detail });
        }
        if (r.status === "pending") {
          const detail = `A Microsoft sign-in page was opened in the user's browser. Ask them to finish signing in there, then call mail_login again. If no page opened, give them this link: ${r.url}`;
          return ok(detail, { status: "pending", url: r.url, detail });
        }
        const detail = `Sign-in did not complete: ${r.detail} Call mail_login to try again.`;
        return ok(detail, { status: "failed", detail });
      }),
  );

  server.registerTool(
    "mail_logout",
    {
      title: "Sign out of Outlook",
      description:
        "Sign the user out: removes the sign-in stored on this computer. Mail tools stop working until mail_login is called again. " +
        "The result includes a link where the user can also withdraw Mail-MCP's access on Microsoft's side.",
      inputSchema: z.object({}).strict(),
      outputSchema: z.object({
        signedOut: z.boolean(),
        account: z.string().optional(),
        revokeUrl: z.string(),
        detail: z.string(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      run(async () => {
        const { account } = await session.logout();
        const detail = logoutDetail(account);
        return ok(
          detail,
          account === undefined
            ? { signedOut: false, revokeUrl: CONSENT_URL, detail }
            : { signedOut: true, account, revokeUrl: CONSENT_URL, detail },
        );
      }),
  );
}
