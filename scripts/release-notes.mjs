// Writes the CHANGELOG.md section for the package.json version to the file named on the
// command line. Exits 1 when that section is missing or empty, so the Release workflow
// stops before `npm publish` instead of after it.
import { readFileSync, writeFileSync } from "node:fs";

const out = process.argv[2];
if (!out) {
  console.error("Usage: node scripts/release-notes.mjs <output file>");
  process.exit(1);
}

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const lines = readFileSync("CHANGELOG.md", "utf8").split(/\r?\n/);
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`CHANGELOG.md has no section for ${version}.`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
if (end === -1) end = lines.length;
const notes = lines.slice(start + 1, end).join("\n").trim();
if (!notes) {
  console.error(`The CHANGELOG.md section for ${version} is empty.`);
  process.exit(1);
}
writeFileSync(out, notes + "\n");
