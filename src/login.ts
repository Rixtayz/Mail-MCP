import open from "open";
import { cachePath, clientId, loginInteractive } from "./auth.js";

/** One-time interactive sign-in. Writes only to stderr so it is safe to call from any context. */
export async function runLogin(): Promise<void> {
  clientId();
  console.error("Opening your browser for Microsoft sign-in…");
  const account = await loginInteractive(async (url) => {
    console.error(`If the browser does not open, visit:\n${url}\n`);
    await open(url);
  });
  console.error(`Signed in as ${account.username}\nToken cache saved to ${cachePath()}`);
}
