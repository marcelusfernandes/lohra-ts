// Falha se algum SHA aprovado em docs/closeout.md não for ancestral do HEAD.
// Uso: npm run provenance:check  (CI: job `provenance`, com fetch-depth: 0)

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { extractApprovedHeads } from "./extract.js";

const root = resolve(import.meta.dirname, "..", "..");
const tablePath = resolve(root, "docs", "closeout.md");

let markdown: string;
try {
  markdown = readFileSync(tablePath, "utf8");
} catch (error) {
  process.stderr.write(`provenance: cannot read ${tablePath}: ${String(error)}\n`);
  process.exit(2);
}

const { approved, skipped } = extractApprovedHeads(markdown);
if (approved.length === 0) {
  process.stderr.write(`provenance: no approved SHA found in ${tablePath}\n`);
  process.exit(2);
}

for (const row of skipped) {
  process.stderr.write(`provenance: ${row.ticket} skipped — not a full SHA: ${row.raw}\n`);
}

const failures = approved.filter(({ sha }) => {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status !== 0;
});

for (const { ticket, sha } of failures) {
  process.stderr.write(`provenance: ${ticket} ${sha} is NOT an ancestor of HEAD\n`);
}
process.stdout.write(
  `provenance: ${String(approved.length - failures.length)}/${String(approved.length)} approved heads are ancestors of HEAD\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
