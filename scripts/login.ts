import open from "open";
import { cachePath, clientId, loginInteractive } from "../src/auth.js";

async function main(): Promise<void> {
  clientId();
  console.error("Opening your browser for Microsoft sign-in…");
  const account = await loginInteractive(async (url) => {
    console.error(`If the browser does not open, visit:\n${url}\n`);
    await open(url);
  });
  console.error(`Signed in as ${account.username}\nToken cache saved to ${cachePath()}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
