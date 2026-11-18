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

// The mcpb CLI installed by `npm ci` from the lock file, run with this Node.js. Never
// `npx mcpb`: when the local copy is missing, npx downloads whatever the registry serves.
const mcpbPackage = join(root, "node_modules", "@anthropic-ai", "mcpb");
let mcpbCli;
try {
  const { bin } = JSON.parse(readFileSync(join(mcpbPackage, "package.json"), "utf8"));
  mcpbCli = join(mcpbPackage, typeof bin === "string" ? bin : bin.mcpb);
} catch {
  // reported below
}
if (!mcpbCli || !existsSync(mcpbCli)) {
  console.error("The local @anthropic-ai/mcpb is missing: run `npm ci` first.");
  process.exit(1);
}

function check(r, what) {
  if (r.status !== 0) {
    console.error(`Command failed (${r.status ?? r.error?.message}): ${what}`);
    process.exit(r.status ?? 1);
  }
}

// One command string with a shell: works with npm on Windows (.cmd) and Unix.
function run(command, cwd) {
  check(spawnSync(command, { cwd, stdio: "inherit", shell: true }), command);
}

// No shell: the arguments reach mcpb as they are, spaces in paths included.
function mcpb(...args) {
  check(spawnSync(process.execPath, [mcpbCli, ...args], { cwd: root, stdio: "inherit" }), `mcpb ${args.join(" ")}`);
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
mcpb("validate", join(stage, "manifest.json"));
mcpb("pack", stage, output);

console.log(`\nBundle: ${output} (${(statSync(output).size / 1024 / 1024).toFixed(1)} MB)`);
