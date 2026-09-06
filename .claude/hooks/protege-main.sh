#!/bin/sh
# PreToolUse hook (Bash): proteção da main do lado do cliente — camada 1
# (ADR 0004 itens 4 e 9; .claude/hooks/README.md). Nega, antes de o comando rodar:
#
#   1. push forçado (--force*, -f, +refspec) em qualquer branch — sem válvula
#   2. push direto em main/master (ref explícita, HEAD:main, ou push a partir de main)
#   3. apagar main/master (git branch -D, git push --delete, :main)
#   4. gh pr merge --admin — sem válvula
#   5. gh pr merge --squash / --rebase (-s / -r) — ADR 0004 exige merge commit; sem válvula
#   6. gh pr merge sem todos os checks verdes, ou sem a label review:approved
#      (nem reviewDecision APPROVED) — a condição mecânica de merge da ADR 0004.
#      WAIVER de classe (issue #61): se TODOS os arquivos da PR são classe `docs`
#      (docs/**, README.md, CLAUDE.md, AGENTS.md — ADR 0004 item 7), a label é
#      dispensada (avisado no stderr); os checks verdes continuam obrigatórios.
#
# Os modos `--all`/`--mirror` do push contam como push em main (empurram toda branch).
# Prefixos com flag: `sudo -u X [--]`, `env -i`, `env -u X`/`env -uX`,
# `env VAR=x [--]`, `nice -n N`/`nice -nN` são atravessados (valor separado ou
# colado ao flag; #77).
#
# O waiver de docs exige `changedFiles == files.length`: o `gh`
# devolve no máximo 100 arquivos em `files`, e uma lista truncada NÃO prova que
# tudo é docs — nega, pedindo a label (fail-closed; revisão da PR #66).
#
# BANCADA (tests/protege-main.test.ts): `LOHRA_BENCH=1` é o único portão que
# habilita as seams LOHRA_PM_BRANCH (branch atual), LOHRA_PM_CHECKS_JSON (saída
# de `gh pr checks --json name,state`), LOHRA_PM_VIEW_JSON (saída de
# `gh pr view --json labels,reviewDecision,files,changedFiles`) e LOHRA_PM_ARGS_OUT
# (arquivo onde o hook anexa, uma por linha, a linha de comando `gh` que
# executaria — a bancada prova que `--repo` e o número da PR são repassados).
# Sem o portão nenhuma é lida.
#
# Válvulas, para bootstrap e operação humana consciente (valem no ambiente do
# hook OU escritas no próprio comando, ex.: `LOHRA_PERMITE_PUSH_MAIN=1 git push`):
#   LOHRA_PERMITE_PUSH_MAIN=1   libera o item 2 (nunca o 1)
#   LOHRA_MERGE_LIVRE=1         libera o item 6 (nunca o 4 nem o 5)
#
# LIMITE DECLARADO (rodada 3, PR #38): o hook lê comandos em POSIÇÃO DE COMANDO —
# início, ou depois de ; | & && || ( ) { } crase e quebra de linha — com os
# prefixos VAR=x, sudo, env, command, builtin, exec, time, nohup, nice, `\`, e as
# palavras if/elif/while/until/then/do/else/!. Evasão deliberada (eval, sh -c,
# variáveis, aliases, scripts) está FORA do escopo deste hook e é backstop das
# camadas 2–4 (pre-push nativo, ruleset, guarda-main). Falso positivo em texto
# como dado depois de um separador (heredoc, echo "…; git push …") é aceito na
# direção segura.
#
# Contrato: JSON da chamada em stdin; nega com permissionDecision "deny" + exit 2.
# Parser em node (pré-requisito do projeto; sem jq). FAIL-CLOSED se node ou git
# faltarem. Portado do Apollo (protege-main.sh); substitui o block-force-push.sh.
set -u
payload=$(cat)

case "$payload" in
  *push*|*merge*|*branch*|*"pr "*) ;;
  *) exit 0 ;;
esac

deny_missing() {
  reason="Bloqueado por .claude/hooks/protege-main.sh: $1 ausente no PATH; nego por segurança (fail-closed)."
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}' "$reason"
  echo "$reason" >&2
  exit 2
}
command -v node >/dev/null 2>&1 || deny_missing node
command -v git >/dev/null 2>&1 || deny_missing git

PM_PAYLOAD="$payload" node -e '
  const { spawnSync } = require("child_process");
  const raw = process.env.PM_PAYLOAD || "";
  let j; try { j = JSON.parse(raw); } catch { process.exit(0); }
  if (j.tool_name !== "Bash") process.exit(0);
  const cmd = (j.tool_input && j.tool_input.command) || "";
  const cwd = j.cwd || process.cwd();
  const bench = process.env.LOHRA_BENCH === "1";
  const seam = (nome) => (bench && ("LOHRA_PM_" + nome) in process.env) ? String(process.env["LOHRA_PM_" + nome]) : undefined;

  const PROTEGIDAS = /^(?:refs\/heads\/)?(?:main|master)$/;
  const negar = (motivo) => {
    const reason = "Bloqueado por .claude/hooks/protege-main.sh: " + motivo +
      " Ver docs/adr/0004-trabalho-autonomo.md e .claude/rules/git-workflow.md.";
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
    process.stderr.write(reason + "\n");
    process.exit(2);
  };
  const sh = (args) => {
    const r = spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8" });
    return { ok: r.status === 0, out: String(r.stdout || ""), err: String(r.stderr || "") };
  };
  // Bancada: sob LOHRA_BENCH=1, LOHRA_PM_ARGS_OUT recebe a linha `gh` que seria executada (#77).
  const registrarArgs = (args) => {
    const alvo = seam("ARGS_OUT");
    if (alvo !== undefined) require("fs").appendFileSync(alvo, args.join(" ") + "\n");
  };
  const branchAtual = () => {
    const viaSeam = seam("BRANCH");
    if (viaSeam !== undefined) return viaSeam;
    const r = sh(["git", "rev-parse", "--abbrev-ref", "HEAD"]);
    if (!r.ok) negar("não consegui ler a branch atual (" + r.err.trim().slice(0, 120) + "); nego por segurança.");
    return r.out.trim();
  };
  const unquote = (t) => t.replace(/^(["\x27])(.*)\1$/, "$2");

  const valvula = (nome) => process.env[nome] === "1" || new RegExp("(?:^|[\\s;&|(){}`])" + nome + "=1(?=\\s)").test(cmd);
  const PERMITE_MAIN = valvula("LOHRA_PERMITE_PUSH_MAIN");
  const MERGE_LIVRE = valvula("LOHRA_MERGE_LIVRE");

  // Segmentos em posição de comando (ver LIMITE DECLARADO no cabeçalho).
  const PALAVRAS = /^(?:(?:if|elif|while|until|then|do|else|!)\s+)*/;
  // sudo: flags com argumento (-u/-g/-C/-D/-h/-p/-r/-T) e flags soltas; env: -i, -u X, VAR=x
  const PREFIXOS = /^(?:\w+=\S*\s+|sudo(?:\s+(?:-[ugCDhprT]\s+\S+|-[A-Za-z]+|--\S*))*\s+|env(?:\s+(?:-i|-u\s*\S+|--\S*|\w+=\S*))*\s+|command\s+|builtin\s+|exec\s+|time\s+|nohup\s+|nice(?:\s+-n\s*\S+)?\s+|\\)*/;
  const segmentos = cmd
    .replace(/&&|\|\|/g, "\n")
    .split(/[;|&\n(){}`]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(PALAVRAS, "").replace(PREFIXOS, "").replace(PALAVRAS, "").replace(PREFIXOS, ""));

  const GIT_OPTS = /^git\s+(?:-C\s+\S+\s+|-c\s+\S+\s+|--\S+\s+)*/;
  for (const seg of segmentos) {
    // ---- git push ---------------------------------------------------------
    const mPush = seg.match(new RegExp(GIT_OPTS.source + "push\\b(.*)$"));
    if (mPush) {
      const tokens = mPush[1].trim().split(/\s+/).filter(Boolean).map(unquote).filter((t) => t !== "--");
      const args = " " + tokens.join(" ");
      const forcado = /--force\b/.test(args) || /(?:^|\s)-[A-Za-z]*f[A-Za-z]*(?=\s|$)/.test(args) || /\s\+\S/.test(args);
      if (forcado) negar("push forçado é proibido em qualquer branch: reescrever histórico quebra o invariante de proveniência (job provenance).");
      const apagar = tokens.includes("--delete") || tokens.includes("-d");
      const refs = tokens.filter((t) => !t.startsWith("-"));
      const refspecs = refs.slice(1); // refs[0] costuma ser o remote
      let alvoMain = false;
      for (const r of refspecs) {
        if (r.startsWith(":") && PROTEGIDAS.test(r.slice(1))) negar("apagar main/master no remoto (:main) é proibido.");
        const dest = r.includes(":") ? r.split(":").pop() : r;
        if (PROTEGIDAS.test(dest)) alvoMain = true;
      }
      if (tokens.includes("--all") || tokens.includes("--mirror")) alvoMain = true; // empurra main junto
      else if (refspecs.length === 0 || refspecs.every((r) => r === "HEAD")) {
        if (PROTEGIDAS.test(branchAtual())) alvoMain = true;
      }
      if (apagar && refspecs.some((r) => PROTEGIDAS.test(r))) negar("apagar main/master no remoto é proibido.");
      if (alvoMain && !PERMITE_MAIN)
        negar("push direto em main/master é proibido; abra uma PR — o orquestrador mergeia com CI verde + review:approved. (LOHRA_PERMITE_PUSH_MAIN=1 só para bootstrap.)");
      continue;
    }
    // ---- git branch -D main ---------------------------------------------
    if (new RegExp(GIT_OPTS.source + "branch\\s+.*(?:-D|--delete\\s+--force|-d)\\s+[\"\\x27]?(?:main|master)[\"\\x27]?(?:\\s|$)").test(seg))
      negar("apagar main/master localmente é proibido.");
    // ---- gh pr merge ------------------------------------------------------
    const mMerge = seg.match(/^gh\s+pr\s+merge\b(.*)$/);
    if (mMerge) {
      const tokens = mMerge[1].trim().split(/\s+/).filter(Boolean).map(unquote);
      if (tokens.includes("--admin")) negar("gh pr merge --admin fura os checks; proibido.");
      if (tokens.some((t) => t === "--squash" || t === "-s" || t === "--rebase" || t === "-r"))
        negar("gh pr merge --squash/--rebase reescreve a branch fora da história; a ADR 0004 exige merge commit (--merge).");
      if (MERGE_LIVRE) continue;
      const COM_VALOR = new Set(["--repo", "-R", "--subject", "-t", "--body", "-b", "--body-file", "-F", "--match-head-commit", "--author-email", "-A"]);
      let alvo = "", repoArg = "";
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.startsWith("--repo=")) { repoArg = t.slice(7); continue; }
        if (COM_VALOR.has(t)) { if ((t === "--repo" || t === "-R") && tokens[i + 1]) repoArg = tokens[i + 1]; i++; continue; }
        if (t.startsWith("-")) continue;
        if (!alvo) alvo = t;
      }
      const ref = alvo ? [alvo] : [];
      const repo = repoArg ? ["--repo", repoArg] : [];
      const argsChecks = ["gh", "pr", "checks", ...ref, ...repo, "--json", "name,state"];
      registrarArgs(argsChecks);
      const checksSeam = seam("CHECKS_JSON");
      const checks = checksSeam !== undefined ? { ok: true, out: checksSeam, err: "" } : sh(argsChecks);
      let lista = null;
      try { lista = JSON.parse(checks.out || "[]"); } catch {}
      if (!Array.isArray(lista)) negar("não consegui ler os checks da PR (" + (checks.err || "sem saída").trim().slice(0, 160) + ").");
      if (lista.length === 0) negar("a PR não tem nenhum check registrado; sem CI não há merge autônomo. (LOHRA_MERGE_LIVRE=1 só para bootstrap.)");
      const ruins = lista.filter((c) => !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(String(c.state).toUpperCase()));
      if (ruins.length) negar("checks não verdes: " + ruins.map((c) => c.name + "=" + c.state).join(", ") + ".");
      const argsView = ["gh", "pr", "view", ...ref, ...repo, "--json", "labels,reviewDecision,files,changedFiles"];
      registrarArgs(argsView);
      const viewSeam = seam("VIEW_JSON");
      const view = viewSeam !== undefined ? { ok: true, out: viewSeam, err: "" } : sh(argsView);
      let pr = null; try { pr = JSON.parse(view.out || "null"); } catch {}
      if (!pr) negar("não consegui ler a PR (" + (view.err || "sem saída").trim().slice(0, 160) + ").");
      const temLabel = (pr.labels || []).some((l) => l.name === "review:approved");
      if (!temLabel && pr.reviewDecision !== "APPROVED") {
        // waiver de classe docs (ADR 0004 item 7): só a label é dispensada; checks acima já foram exigidos
        const ehDocs = (f) => f === "README.md" || f === "CLAUDE.md" || f === "AGENTS.md" || f.startsWith("docs/");
        const arquivos = Array.isArray(pr.files) ? pr.files.map((f) => String(f && f.path || "")) : [];
        const total = typeof pr.changedFiles === "number" ? pr.changedFiles : -1;
        if (arquivos.length > 0 && total !== arquivos.length)
          negar("a lista de arquivos da PR veio truncada (" + arquivos.length + " de " + total + "); não dá para provar que é classe docs — o waiver não se aplica, aplique review:approved.");
        if (arquivos.length > 0 && arquivos.every(ehDocs)) {
          process.stderr.write("protege-main: PR de classe docs (" + arquivos.length + " arquivo(s) em docs/**, README, CLAUDE.md, AGENTS.md): label review:approved dispensada; checks verdes conferidos.\n");
        } else {
          negar("a PR não tem a label review:approved nem review APPROVED; o revisor precisa passar e o orquestrador aplicar a label antes do merge (ADR 0004 item 4).");
        }
      }
    }
  }
  process.exit(0);
'
exit $?
