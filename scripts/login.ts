import { runLogin } from "../src/login.js";

runLogin().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
