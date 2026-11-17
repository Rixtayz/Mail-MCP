// Builds mail-mcp-<version>.mcpb (Claude Desktop extension) at the repo root.
// Run `npm run build` first: the bundle ships the compiled dist/ folder.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "build", "mcpb");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const output = join(root, `mail-mcp-${version}.mcpb`);

if (!existsSync(join(root, "dist", "index.js"))) {
  console.error("dist/ is missing: run `npm run build` first.");
  process.exit(1);
}

// One command string with a shell: works with npm/npx on Windows (.cmd) and Unix.
function run(command, cwd) {
  const r = spawnSync(command, { cwd, stdio: "inherit", shell: true });
  if (r.status !== 0) {
    console.error(`Command failed (${r.status}): ${command}`);
    process.exit(r.status ?? 1);
  }
}

rmSync(stage, { recursive: true, force: true });
rmSync(output, { force: true });
mkdirSync(stage, { recursive: true });

cpSync(join(root, "mcpb", "manifest.json"), join(stage, "manifest.json"));
if (existsSync(join(root, "mcpb", "icon.png"))) {
  cpSync(join(root, "mcpb", "icon.png"), join(stage, "icon.png"));
}
cpSync(join(root, "package.json"), join(stage, "package.json"));
cpSync(join(root, "package-lock.json"), join(stage, "package-lock.json"));
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });

run("npm ci --omit=dev --ignore-scripts", stage);
run(`npx mcpb validate "${join(stage, "manifest.json")}"`, root);
run(`npx mcpb pack "${stage}" "${output}"`, root);

console.log(`\nBundle: ${output} (${(statSync(output).size / 1024 / 1024).toFixed(1)} MB)`);
