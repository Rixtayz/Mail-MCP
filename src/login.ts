import { rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import open from "open";
import { cachePath, loginInteractive } from "./auth.js";

/** An HTML file that sends the browser on to the sign-in URL, in a folder of its own. */
export interface SignInPage {
  file: string;
  /** Deletes the page and its folder. Safe to call more than once. */
  remove(): Promise<void>;
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * Writes the sign-in page: a meta refresh and a link to the URL, nothing else (no script). The folder comes from
 * mkdtemp, which creates it 0700; the file is created 0600. Opening this file instead of the URL keeps the URL,
 * with its state and loopback port, off the command line of the process that opens the browser, where other
 * programs on the computer can read it. The folder is also deleted if the process exits first.
 */
export async function writeSignInPage(url: string): Promise<SignInPage> {
  let href: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") throw new Error("not https");
    href = escapeHtml(parsed.href);
  } catch {
    throw new Error("The sign-in page was not written: the sign-in link is not an https address.");
  }
  const dir = await mkdtemp(join(tmpdir(), "mail-mcp-sign-in-"));
  const file = join(dir, "sign-in.html");
  const onExit = (): void => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort: the process is exiting.
    }
  };
  process.on("exit", onExit);
  let removing: Promise<void> | undefined;
  const remove = (): Promise<void> =>
    (removing ??= (async () => {
      process.off("exit", onExit);
      await rm(dir, { recursive: true, force: true });
    })());
  const html =
    "<!doctype html>\n" +
    '<meta charset="utf-8">\n' +
    `<meta http-equiv="refresh" content="0;url=${href}">\n` +
    "<title>Mail-MCP sign-in</title>\n" +
    `<a href="${href}">Continue to the Microsoft sign-in page</a>\n`;
  try {
    await writeFile(file, html, { flag: "wx", mode: 0o600 });
  } catch (err) {
    await remove();
    throw err;
  }
  return { file, remove };
}

/**
 * Opens the sign-in URL in the browser through a sign-in page (see writeSignInPage), and resolves to the function
 * that deletes the page, to call when the sign-in ends: the browser reads the file some time after the opener
 * returns. If the opener fails, the page is deleted at once and the error passed on.
 *
 * The default opener, `open`, never goes through cmd.exe: it runs `open` on macOS and `xdg-open` on Linux with the
 * path as one argument, and on Windows PowerShell's Start-Process with the path single-quoted inside an encoded
 * command, so spaces and shell characters in the temporary folder's path are safe. Each opens a `.html` file with
 * the default browser. It resolves once the launcher has started (on Windows, once PowerShell has started the
 * browser and exited).
 */
export async function openSignInPage(
  url: string,
  opener: (target: string) => Promise<unknown> = open,
): Promise<() => Promise<void>> {
  const page = await writeSignInPage(url);
  try {
    await opener(page.file);
  } catch (err) {
    await page.remove();
    throw err;
  }
  return page.remove;
}

/** One-time interactive sign-in. Writes only to stderr so it is safe to call from any context. */
export async function runLogin(): Promise<void> {
  console.error("Opening your browser for Microsoft sign-in…");
  const pages: (() => Promise<void>)[] = [];
  try {
    const account = await loginInteractive(async (url) => {
      console.error(`If the browser does not open, visit:\n${url}\n`);
      pages.push(await openSignInPage(url));
    });
    console.error(`Signed in as ${account.username}\nToken cache saved to ${cachePath()}`);
  } finally {
    await Promise.all(pages.map((remove) => remove()));
  }
}
