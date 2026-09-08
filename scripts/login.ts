import open from "open";
import { cachePath, clientId, loginInteractive } from "../src/auth.js";

async function main(): Promise<void> {
  clientId();
  console.error("Ouverture du navigateur pour la connexion Microsoft…");
  const account = await loginInteractive(async (url) => {
    console.error(`Si le navigateur ne s'ouvre pas, visitez :\n${url}\n`);
    await open(url);
  });
  console.error(`Connecté : ${account.username}\nJeton enregistré dans ${cachePath()}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
