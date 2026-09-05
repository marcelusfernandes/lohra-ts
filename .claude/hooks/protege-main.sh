#!/bin/sh
# PreToolUse hook (Bash): proteção da main do lado do cliente — camada 1 de 4
# (ADR 0004 item 4 e 9; .claude/hooks/README.md). Nega, antes de o comando rodar:
#
#   1. push forçado (--force*, -f, +refspec) em qualquer branch — sem válvula
#   2. push direto em main/master (ref explícita, HEAD:main, ou push a partir de main)
#   3. apagar main/master (git branch -D, git push --delete)
#   4. gh pr merge --admin — sem válvula
#   5. gh pr merge sem todos os checks verdes, ou sem a label review:approved
#      (nem reviewDecision APPROVED) — a condição mecânica de merge da ADR 0004
#
# Válvulas, para bootstrap e operação humana consciente (valem no ambiente do
# hook OU escritas no próprio comando, ex.: `LOHRA_PERMITE_PUSH_MAIN=1 git push`):
#   LOHRA_PERMITE_PUSH_MAIN=1   libera o item 2 (nunca o 1)
#   LOHRA_MERGE_LIVRE=1         libera o item 5 (nunca o 4)
#
# Contrato: JSON da chamada em stdin; nega com permissionDecision "deny" + exit 2.
# Parser em node (pré-requisito do projeto; sem jq). Fail-open se node faltar: há
# o pre-push do git, o ruleset e o guarda-main como backstop. Portado do Apollo
# (protege-main.sh); substitui o antigo block-force-push.sh.
set -u
payload=$(cat)

case "$payload" in
  *push*|*merge*|*branch*|*"pr "*) ;;
  *) exit 0 ;;
esac

PM_PAYLOAD="$payload" node -e '
  const { spawnSync } = require("child_process");
  const raw = process.env.PM_PAYLOAD || "";
  let j; try { j = JSON.parse(raw); } catch { process.exit(0); }
  if (j.tool_name !== "Bash") process.exit(0);
  const cmd = (j.tool_input && j.tool_input.command) || "";
  const cwd = j.cwd || process.cwd();

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
  const branchAtual = () => { const r = sh(["git", "rev-parse", "--abbrev-ref", "HEAD"]); return r.ok ? r.out.trim() : ""; };

  const valvula = (nome) => process.env[nome] === "1" || new RegExp("(?:^|[\\s;&|(])" + nome + "=1(?=\\s)").test(cmd);
  const PERMITE_MAIN = valvula("LOHRA_PERMITE_PUSH_MAIN");
  const MERGE_LIVRE = valvula("LOHRA_MERGE_LIVRE");

  // Segmentos em posição de comando: início ou depois de ; && || | ( e quebra de linha.
  const segmentos = cmd.split(/&&|\|\||[;|\n(]/).map((s) => s.trim()).filter(Boolean)
    .map((s) => s.replace(/^(?:\w+=\S*\s+|sudo\s+|env\s+)*/, ""));

  for (const seg of segmentos) {
    // ---- git push ---------------------------------------------------------
    const mPush = seg.match(/^git\s+(?:-C\s+\S+\s+|--\S+\s+)*push\b(.*)$/);
    if (mPush) {
      const args = mPush[1];
      const forcado = /--force\b/.test(args) || /(?:^|\s)-[A-Za-z]*f[A-Za-z]*(?=\s|$)/.test(args) || /\s\+\S/.test(args);
      if (forcado) negar("push forçado é proibido em qualquer branch: reescrever histórico quebra o invariante de proveniência (job provenance).");
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const apagar = tokens.includes("--delete") || tokens.includes("-d");
      const refs = tokens.filter((t) => !t.startsWith("-"));
      const refspecs = refs.slice(1); // refs[0] costuma ser o remote
      let alvoMain = false;
      for (const r of refspecs) {
        const dest = r.includes(":") ? r.split(":").pop() : r;
        if (PROTEGIDAS.test(dest)) alvoMain = true;
      }
      if (refspecs.length === 0 || refspecs.every((r) => r === "HEAD")) {
        if (PROTEGIDAS.test(branchAtual())) alvoMain = true;
      }
      if (apagar && refspecs.some((r) => PROTEGIDAS.test(r))) negar("apagar main/master no remoto é proibido.");
      if (alvoMain && !PERMITE_MAIN)
        negar("push direto em main/master é proibido; abra uma PR — o orquestrador mergeia com CI verde + review:approved. (LOHRA_PERMITE_PUSH_MAIN=1 só para bootstrap.)");
      continue;
    }
    // ---- git branch -D main ---------------------------------------------
    if (/^git\s+branch\s+.*(?:-D|--delete\s+--force|-d)\s+(?:main|master)\b/.test(seg))
      negar("apagar main/master localmente é proibido.");
    // ---- gh pr merge ------------------------------------------------------
    const mMerge = seg.match(/^gh\s+pr\s+merge\b(.*)$/);
    if (mMerge) {
      const args = mMerge[1];
      if (/--admin\b/.test(args)) negar("gh pr merge --admin fura os checks; proibido.");
      if (MERGE_LIVRE) continue;
      const alvo = args.trim().split(/\s+/).filter((t) => t && !t.startsWith("-"))[0] || "";
      const ref = alvo ? [alvo] : [];
      const repoArg = (args.match(/(?:--repo|-R)\s+(\S+)/) || [])[1];
      const repo = repoArg ? ["--repo", repoArg] : [];
      const checks = sh(["gh", "pr", "checks", ...ref, ...repo, "--json", "name,state"]);
      let lista = null;
      try { lista = JSON.parse(checks.out || "[]"); } catch {}
      if (!Array.isArray(lista)) negar("não consegui ler os checks da PR (" + (checks.err || "sem saída").trim().slice(0, 160) + ").");
      if (lista.length === 0) negar("a PR não tem nenhum check registrado; sem CI não há merge autônomo. (LOHRA_MERGE_LIVRE=1 só para bootstrap.)");
      const ruins = lista.filter((c) => !["SUCCESS", "SKIPPED", "NEUTRAL"].includes(String(c.state).toUpperCase()));
      if (ruins.length) negar("checks não verdes: " + ruins.map((c) => c.name + "=" + c.state).join(", ") + ".");
      const view = sh(["gh", "pr", "view", ...ref, ...repo, "--json", "labels,reviewDecision"]);
      let pr = null; try { pr = JSON.parse(view.out || "null"); } catch {}
      if (!pr) negar("não consegui ler a PR (" + (view.err || "sem saída").trim().slice(0, 160) + ").");
      const temLabel = (pr.labels || []).some((l) => l.name === "review:approved");
      if (!temLabel && pr.reviewDecision !== "APPROVED")
        negar("a PR não tem a label review:approved nem review APPROVED; o revisor precisa passar e o orquestrador aplicar a label antes do merge (ADR 0004 item 4).");
    }
  }
  process.exit(0);
'
exit $?
