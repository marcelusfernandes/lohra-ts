#!/bin/sh
# Hook Stop: gate de fim de turno (issue #43, sub-issue de #33; ADR 0004;
# .claude/hooks/README.md). Substitui o tsc-check.sh. Roda antes de o agente
# encerrar o turno:
#
#   1. `tsc --noEmit` SEMPRE (comportamento do tsc-check.sh, mantido). Sem o
#      binário local (node_modules ausente) avisa e segue — o agente não tem
#      como consertar isso encerrando ou não o turno.
#   2. `npm run prova -- <slug>`, com o slug tirado de `git branch --show-current`
#      no padrão `<type>/<n>-<slug>` (mesma regra de scripts/prova/slug.ts, #42;
#      candidato único: prova/<slug>.ts). NÃO bloqueia quando:
#        - a branch está fora do padrão (main, worktree-agent-*, …);
#        - o último commit começa com `test(red):` — é o controle negativo, a
#          prova DEVE estar vermelha nesse ponto;
#        - não existe prova/<slug>.ts — ausência de declaração não é prova
#          vermelha (não há o que provar ainda); avisa e sai 0.
#      Prova vermelha (existe e reprova) -> exit 2 com .prova/<slug>/resumo.json
#      no stderr, e o agente continua até ficar verde ("loop until green").
#
# BANCADA: `LOHRA_BENCH=1` é o único portão que habilita as seams
# LOHRA_STOP_BRANCH, LOHRA_STOP_LAST_COMMIT_MSG, LOHRA_STOP_TSC_CMD e
# LOHRA_STOP_PROVA_CMD (tests/stop-gate.test.ts). Sem LOHRA_BENCH nenhuma delas
# é lida: o hook roda tsc e prova de verdade a partir do estado real do repo.
# Ninguém além da bancada exporta essas variáveis para o processo do hook — um
# `export` numa chamada Bash do agente não sobrevive até aqui.
#
# REENTRÂNCIA: o filho da prova recebe LOHRA_STOP_GATE_ACTIVE=1. Se o hook já
# encontra essa marca no ambiente (e não está em bancada), sai 0 na hora: uma
# prova que exercite hooks (como a deste próprio arquivo) chamaria o hook de
# novo, que chamaria a prova de novo, sem fim. Em bancada a marca é ignorada e a
# seam decide, senão os casos da bancada que esperam exit 2 sairiam 0.
#
# HERMETICIDADE: o filho nunca herda LOHRA_STOP_* do ambiente do hook — só a
# marca acima, reposta explicitamente depois da limpeza. Assim uma seam da
# bancada não vaza para um vitest real que a prova esteja rodando.
#
# Contrato: JSON do evento em stdin (`cwd`); exit 2 bloqueia o encerramento.
# Raiz = toplevel git do `cwd` do payload (worktree de agente inclusive); sem
# git, o próprio `cwd`. Parser em node (pré-requisito do projeto; sem jq).
# Portado do Apollo (stop-gate.sh), sem o mapeamento m0-* nem pacotes por pasta.
set -u
payload=$(cat 2>/dev/null || true)

if ! command -v node >/dev/null 2>&1; then
  echo "stop-gate: node ausente no PATH; não consigo rodar tsc nem prova (fail-open, avisado)." >&2
  exit 0
fi

SG_PAYLOAD="$payload" node -e '
  const { spawnSync } = require("child_process");
  const fs = require("fs");
  const path = require("path");

  let j = {};
  try { j = JSON.parse(process.env.SG_PAYLOAD || "{}") || {}; } catch { /* payload ilegível: segue com cwd do processo */ }
  const bench = process.env.LOHRA_BENCH === "1";
  const seam = (nome) => (bench && ("LOHRA_STOP_" + nome) in process.env) ? String(process.env["LOHRA_STOP_" + nome]) : undefined;
  const aviso = (m) => process.stderr.write("stop-gate: " + m + "\n");

  if (process.env.LOHRA_STOP_GATE_ACTIVE === "1" && !bench) {
    aviso("chamada reentrante (LOHRA_STOP_GATE_ACTIVE já no ambiente, via prova -> vitest -> hook); saindo 0 sem rodar tsc/prova de novo.");
    process.exit(0);
  }

  const cwd = j.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  const root = top.status === 0 ? top.stdout.trim() : cwd;
  const git = (args) => (spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout || "").trim();

  const rodar = (cmd, extra) => {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("LOHRA_STOP_")) env[k] = v;
    Object.assign(env, extra || {});
    return spawnSync("sh", ["-c", cmd], { cwd: root, encoding: "utf8", env });
  };

  // ---- 1. tsc, sempre ------------------------------------------------------
  let tscCmd = seam("TSC_CMD");
  if (tscCmd === undefined) {
    const bin = path.join(root, "node_modules", ".bin", "tsc");
    if (fs.existsSync(bin)) tscCmd = JSON.stringify(bin) + " --noEmit";
    else aviso("tsc não instalado em " + root + " (node_modules ausente?); pulando o type-check.");
  }
  if (tscCmd !== undefined) {
    const r = rodar(tscCmd);
    if (r.status !== 0) {
      const saida = ((r.stdout || "") + (r.stderr || "")).split("\n").slice(0, 40).join("\n");
      process.stderr.write(saida + "\n");
      aviso("tsc --noEmit falhou (acima). Corrija antes de encerrar o turno.");
      process.exit(2);
    }
  }

  // ---- 2. prova do slug da branch, com as exceções ---------------------------
  const branch = seam("BRANCH") ?? git(["branch", "--show-current"]);
  const m = branch.match(/^[a-z]+\/[0-9]+-([a-z0-9-]+)$/);
  if (!m) {
    aviso("branch \"" + branch + "\" fora do padrão <type>/<n>-<slug>; pulando a prova (não bloqueia).");
    process.exit(0);
  }
  const slug = m[1];
  const ultimo = seam("LAST_COMMIT_MSG") ?? git(["log", "-1", "--pretty=%s"]);
  if (ultimo.startsWith("test(red):")) {
    aviso("último commit é test(red): — controle negativo; pulando a prova (não bloqueia).");
    process.exit(0);
  }
  if (!fs.existsSync(path.join(root, "prova", slug + ".ts"))) {
    aviso("nenhum prova/" + slug + ".ts para a branch \"" + branch + "\"; nada a provar ainda (não bloqueia).");
    process.exit(0);
  }
  const provaCmd = seam("PROVA_CMD") ?? ("npm run -s prova -- " + JSON.stringify(slug));
  const r = rodar(provaCmd, { LOHRA_STOP_GATE_ACTIVE: "1" });
  if (r.status !== 0) {
    const resumoPath = path.join(root, ".prova", slug, "resumo.json");
    let resumo = "(sem " + path.relative(root, resumoPath) + ")";
    try { resumo = fs.readFileSync(resumoPath, "utf8"); } catch { /* sem resumo: fica a mensagem acima */ }
    aviso("a prova de \"" + slug + "\" reprovou (`" + provaCmd + "`).\n" + resumo);
    process.exit(2);
  }
  process.exit(0);
'
exit $?
