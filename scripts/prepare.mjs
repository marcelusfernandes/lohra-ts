import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import process from "node:process";

// Issue #530: este arquivo nasceu do split de `scripts/postinstall.mjs` —
// tudo aqui só faz sentido em checkout de dev, nunca num pacote publicado.
// `prepare` roda em `npm ci`/`npm install` sem argumentos quando há `.git`
// (ou como parte de instalação de dependência git) — não roda em
// `npm install -g <pacote>` a partir do tarball/registry, e por isso não
// entra em `files` (não é publicado).

// Camada 2 da proteção da main (.claude/hooks/README.md): instala o hook
// pre-push nativo em checkouts git. Sem `.git`/`.claude` (não deveria
// acontecer aqui, mas o script é defensivo) pula; o instalador é
// idempotente. Falha aqui não quebra o install (o hook não é a única
// barreira), mas nunca é silenciosa.
// stdout/stderr do instalador vão para o fd 2 (stderr) do processo pai, não
// para o fd 1 (stdout): `npm pack`/`npm publish` rodam `prepare` mesmo em
// dry-run e mesmo com `--ignore-scripts` (comportamento do npm 10), e
// qualquer ferramenta que espere `--json` limpo no stdout (`npm pack --json`,
// `scripts/pack-check.ts`, `tests/package-manifest.test.ts`) quebraria com a
// saída informativa do instalador misturada no meio.
const installer = join(process.cwd(), ".claude", "hooks", "instalar-git-hooks.sh");
if (existsSync(join(process.cwd(), ".git")) && existsSync(installer)) {
  const result = spawnSync("sh", [installer], { stdio: ["ignore", 2, 2] });
  if (result.status !== 0)
    process.stderr.write(
      "prepare: instalar-git-hooks.sh falhou (exit " + String(result.status) + ")" + "\n",
    );
}

// Pre-commit local via lefthook (issue #63, lefthook.yml): prettier --check
// + eslint nos arquivos staged. `lefthook install` sem argumento instala
// todos os hooks do lefthook.yml e faz backup dos existentes; usamos
// `install pre-commit` (escopo explícito) para que o pre-push nativo
// continue sendo o instalado acima (README "Desenvolvimento"). Sem `.git`
// ou sem o binário (instalação de produção, `--omit=dev`, sem
// devDependencies) pula em silêncio; falha aqui também não quebra o install
// (o hook não é a única barreira).
if (existsSync(join(process.cwd(), ".git"))) {
  const lefthookBin = join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "lefthook.cmd" : "lefthook",
  );
  if (existsSync(lefthookBin)) {
    const lefthookResult = spawnSync(lefthookBin, ["install", "pre-commit"], {
      stdio: ["ignore", 2, 2],
    });
    if (lefthookResult.status !== 0)
      process.stderr.write(
        "prepare: lefthook install pre-commit falhou (exit " +
          String(lefthookResult.status) +
          ")\n",
      );
  }
}
