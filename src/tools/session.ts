import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { loginInteractive, logout, signedInAccount } from "../auth.js";
import { CONSENT_URL, LOGIN_GIVE_UP_MS, LOGIN_WAIT_MS } from "../constants.js";
import { openSignInPage } from "../login.js";
import { LoginFlow, cancelLoopback, type LoginStatus } from "../session.js";
import { ok, run } from "./shared.js";

export interface SessionService {
  login(): Promise<LoginStatus>;
  /** `notRemoved`: leftover temporary cache files that could not be deleted. */
  logout(): Promise<{ account?: string; notRemoved?: string[] }>;
}

/**
 * The real service. Each call makes its own LoginFlow, and buildServer() calls it once per server,
 * so overlapping mail_login calls to one server share a single browser sign-in.
 */
export function createSessionService(): SessionService {
  const flow = new LoginFlow({
    signedInAccount,
    loginInteractive,
    // Opens a sign-in page holding the URL, so the URL stays off the launcher's command line. The page is
    // deleted when the sign-in ends.
    openBrowser: (url) => openSignInPage(url),
    cancel: (authUrl) => cancelLoopback(authUrl),
    waitMs: LOGIN_WAIT_MS,
    giveUpMs: LOGIN_GIVE_UP_MS,
  });
  return sessionService(flow, logout);
}

/**
 * Sign-in through the flow. Sign-out first cancels a sign-in still waiting in the browser and waits for it to
 * end, so that finishing it afterwards cannot sign the user back in, then removes the stored sign-in.
 */
export function sessionService(
  flow: Pick<LoginFlow, "start" | "cancel">,
  signOut: SessionService["logout"],
): SessionService {
  return {
    login: () => flow.start(),
    logout: async () => {
      await flow.cancel();
      return signOut();
    },
  };
}

/**
 * The text a logout reports, shared by the mail_logout tool and `mail-mcp logout`. `notRemoved` lists the
 * leftover temporary cache files that could not be deleted: the text names them, since they may hold a token.
 */
export function logoutDetail(account: string | undefined, notRemoved: readonly string[] = []): string {
  const revoke = `To ${account === undefined ? "" : "also "}withdraw Mail-MCP's access on Microsoft's side, the user can open ${CONSENT_URL}.`;
  if (notRemoved.length === 0) {
    return account === undefined ? `No account was signed in. ${revoke}` : `Signed out of ${account}. The local sign-in was removed. ${revoke}`;
  }
  const one = notRemoved.length === 1;
  const leftover =
    `${one ? "a temporary file" : `${notRemoved.length} temporary files`} that an interrupted save left, which may hold a token, ` +
    `could not be deleted: ${notRemoved.join(", ")}. Ask the user to delete ${one ? "it" : "them"}.`;
  return account === undefined
    ? `No account was signed in, but ${leftover} ${revoke}`
    : `Signed out of ${account}. The sign-in cache file was removed, but ${leftover} ${revoke}`;
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
          const detail = `A Microsoft sign-in page was opened in the user's browser. Ask them to finish signing in there, then call mail_login again. If the user does not see a Microsoft sign-in page (for example a 'file not found' page from a sandboxed browser such as Ubuntu's Firefox snap), give them this link: ${r.url}`;
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
        const { account, notRemoved } = await session.logout();
        const detail = logoutDetail(account, notRemoved);
        return ok(
          detail,
          account === undefined
            ? { signedOut: false, revokeUrl: CONSENT_URL, detail }
            : { signedOut: true, account, revokeUrl: CONSENT_URL, detail },
        );
      }),
  );
}
