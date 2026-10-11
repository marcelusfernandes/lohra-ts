// Reproduz somente a fixture de archive em repositórios Git temporários próprios.
// Uso: node probe.mjs <OWN_OUTPUT_DIR>. Não altera configuração Git global.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const output = process.argv[2];
if (!output) throw new Error("usage: node probe.mjs <OWN_OUTPUT_DIR>");
const ownRoot = resolve(output);
mkdirSync(ownRoot, { recursive: true });

function command(cwd, program, args, input) {
  const result = spawnSync(program, args, { cwd, input, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} ${args.join(" ")} failed: ${result.error ?? result.stderr}`);
  }
  return result.stdout;
}

function config(cwd, scope) {
  const args = ["config", ...(scope === "local" ? ["--local"] : []), "--get", "core.autocrlf"];
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status === 1) return null;
  if (result.status !== 0) throw new Error(`git config failed: ${result.stderr}`);
  return result.stdout.trim();
}

const records = [];
for (const mode of ["inherited", "local-false"]) {
  const repo = mkdtempSync(join(ownRoot, `${mode}-repo-`));
  command(repo, "git", ["init", "-q", "-b", "main"]);
  command(repo, "git", ["config", "--local", "user.name", "Probe"]);
  command(repo, "git", ["config", "--local", "user.email", "probe@example.com"]);
  if (mode === "local-false") command(repo, "git", ["config", "--local", "core.autocrlf", "false"]);
  const effective = config(repo, "effective");
  const local = config(repo, "local");
  writeFileSync(join(repo, "a.txt"), "versao-1\n");
  command(repo, "git", ["add", "-A"]);
  command(repo, "git", ["commit", "-q", "-m", "v1"]);
  const shaV1 = command(repo, "git", ["rev-parse", "HEAD"]).toString("utf8").trim();
  const blobV1 = command(repo, "git", ["show", `${shaV1}:a.txt`]);
  writeFileSync(join(repo, "a.txt"), "versao-2\n");
  command(repo, "git", ["add", "-A"]);
  command(repo, "git", ["commit", "-q", "-m", "v2"]);
  const blobV2 = command(repo, "git", ["show", "HEAD:a.txt"]);
  const archive = command(repo, "git", ["archive", "--format=tar", shaV1]);
  const extracted = mkdtempSync(join(ownRoot, `${mode}-archive-`));
  command(repo, "tar", ["-xf", "-", "-C", extracted], archive);
  const archiveV1 = readFileSync(join(extracted, "a.txt"));
  const clean = command(repo, "git", ["status", "--porcelain"]).length === 0;
  records.push({
    mode,
    coreAutocrlfEffective: effective,
    coreAutocrlfLocal: local,
    blobV1Hex: blobV1.toString("hex"),
    blobV2Hex: blobV2.toString("hex"),
    archiveRequestedV1Hex: archiveV1.toString("hex"),
    headIsV2: blobV2.toString("utf8") === "versao-2\n",
    clean,
  });
}
writeFileSync(join(ownRoot, "probe-result.json"), `${JSON.stringify(records, null, 2)}\n`);
console.log(JSON.stringify(records));
