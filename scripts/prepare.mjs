import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import process from "node:process";

// Issue #530: este arquivo nasceu do split de `scripts/postinstall.mjs` —
// tudo aqui só faz sentido em checkout de dev, nunca num pacote publicado.
// `prepare` roda em `npm ci`/`npm install` sem argumentos quando há `.git`
// (ou como parte de instalação de dependência git) — não roda em
// `npm install -g <pacote>` a partir do tarball/registry, e por isso não
// entra em `files` (não é publicado).

// Issue #544 (D9 do épico #529, follow-up de #530/PR #541): `npm pack`
// roda este script mesmo com `--ignore-scripts` (comportamento do npm 10,
// verificado na PR #541), então `scripts/pack-check.ts` e
// `tests/package-manifest.test.ts` — que chamam `npm pack` para inspecionar
// o tarball, não para instalar nada — instalavam os hooks de git no
// checkout real a cada corrida. Os dois setam `LOHRA_SKIP_PREPARE=1` no
// `env` do `npm pack` que executam; com a variável, este script não toca em
// `.git/hooks` nem no lefthook e sai 0 — a falha nunca é silenciosa: avisa
// no stderr que pulou, para quem olhar o log entender por quê.
if (process.env.LOHRA_SKIP_PREPARE === "1") {
  process.stderr.write("prepare: pulado (LOHRA_SKIP_PREPARE=1)\n");
  process.exit(0);
}

// Instala hooks somente em checkout de desenvolvimento. O script shell
// histórico não é portável: `sh` pode estar fora do PATH no Windows e o
// wrapper `lefthook.cmd` não é executável por spawnSync sem shell. Git resolve
// o diretório comum de hooks também quando `.git` é um arquivo de worktree.
const root = process.cwd();
if (existsSync(join(root, ".git"))) {
  const installer = join(root, ".claude", "hooks", "instalar-git-hooks.sh");
  if (existsSync(installer)) {
    try {
      const source = join(root, ".claude", "hooks", "git-pre-push");
      const result = spawnSync("git", ["rev-parse", "--git-path", "hooks"], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      });
      if (result.error !== undefined || result.status !== 0) {
        const cause = result.error?.message ?? result.stderr.trim();
        const code = result.error?.code ?? result.signal ?? `exit ${String(result.status)}`;
        throw new Error(`git hooks path: ${code}: ${cause}`);
      }
      const hooksPath = result.stdout.trim();
      if (hooksPath === "") throw new Error("git hooks path: empty output");
      const destination = join(resolve(root, hooksPath), "pre-push");
      const sourceBytes = readFileSync(source);
      mkdirSync(resolve(root, hooksPath), { recursive: true });
      if (!existsSync(destination) || !readFileSync(destination).equals(sourceBytes)) {
        copyFileSync(source, destination);
        chmodSync(destination, 0o755);
        process.stderr.write(`prepare: pre-push instalado: ${destination}\n`);
      } else {
        process.stderr.write(`prepare: pre-push em dia: ${destination}\n`);
      }
    } catch (cause) {
      const code = cause instanceof Error && "code" in cause ? `${String(cause.code)}: ` : "";
      process.stderr.write(`prepare: pre-push falhou: ${code}${String(cause)}\n`);
      process.exitCode = 1;
    }
  }

  // `lefthook` é devDependency opcional em instalações --omit=dev. Quando
  // presente, chamar sua entrada JS pelo Node atual preserva argv sem shell
  // e mantém o pre-commit escopado; stdout informativo vai ao stderr para
  // não corromper `npm pack --json`.
  const lefthook = join(root, "node_modules", "lefthook", "bin", "index.js");
  if (existsSync(lefthook)) {
    const result = spawnSync(process.execPath, [lefthook, "install", "pre-commit"], {
      cwd: root,
      stdio: ["ignore", 2, 2],
      windowsHide: true,
    });
    if (result.error !== undefined || result.status !== 0) {
      const cause = result.error?.message;
      const code = result.error?.code ?? result.signal ?? `exit ${String(result.status)}`;
      process.stderr.write(
        `prepare: lefthook install pre-commit falhou (${code}${cause ? `: ${cause}` : ""})\n`,
      );
      process.exitCode = 1;
    }
  }
}
