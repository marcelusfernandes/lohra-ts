import { chmodSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

if (process.platform !== "win32") {
  const helper = join(
    process.cwd(),
    "node_modules",
    "node-pty",
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );
  if (existsSync(helper)) chmodSync(helper, 0o755);
}

// Camada 2 da proteção da main (.claude/hooks/README.md): instala o hook
// pre-push nativo em checkouts git. Instalação por tarball não tem .git nem
// .claude/ e pula; o instalador é idempotente. Falha aqui não quebra o install
// (o hook não é a única barreira), mas nunca é silenciosa.
const installer = join(process.cwd(), ".claude", "hooks", "instalar-git-hooks.sh");
if (existsSync(join(process.cwd(), ".git")) && existsSync(installer)) {
  const result = spawnSync("sh", [installer], { stdio: "inherit" });
  if (result.status !== 0)
    console.error("postinstall: instalar-git-hooks.sh falhou (exit " + String(result.status) + ")");
}
