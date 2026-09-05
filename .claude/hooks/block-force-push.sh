#!/bin/sh
# PreToolUse hook (Bash): nega `git push` com semântica de force antes de rodar.
#
# Backstop determinístico da regra em .claude/rules/git-workflow.md ("nunca
# force-push"). Reescrever histórico quebra o invariante de proveniência
# (docs/closeout.md, job `provenance` do CI). Portado do Marvinz.
#
# Contrato PreToolUse: JSON da chamada em stdin; comando em tool_input.command.
# Para negar: JSON com permissionDecision "deny" em stdout e exit 2.
#
# Parser: node (pré-requisito do projeto; sem jq). Caminho rápido abaixo evita
# spawnar node quando o payload nem menciona "push". Se node faltar, sai com
# código diferente de 2 (não bloqueia) — fail-open deliberado: a proteção
# server-side da main é o backstop real, e bloquear todo push por falta de
# interpretador seria pior que a lacuna.
set -u
payload=$(cat)

case "$payload" in
  *push*) ;;
  *) exit 0 ;;
esac

BFP_PAYLOAD="$payload" node -e '
  const raw = process.env.BFP_PAYLOAD || "";
  let j;
  try { j = JSON.parse(raw); } catch { process.exit(0); }
  if (j.tool_name !== "Bash") process.exit(0);
  const cmd = (j.tool_input && j.tool_input.command) || "";

  // "git ... push" em POSIÇÃO DE COMANDO (início de linha ou após ; && || | \n "("),
  // opcionalmente atrás de VAR=x / sudo / env. A frase como dado sem separador
  // antes (echo "git push --force") passa; com separador dentro de uma string
  // ("&& git push --force") é negada — falso positivo na direção segura.
  // Tolera "git -C dir push" e "git --no-pager push".
  const m = cmd.match(
    /(?:^|[;&|\n(])\s*((?:\w+=\S*\s+|sudo\s+|env\s+)*git\s+(?:-C\s+\S+\s+|--\S+\s+)*push\b)/
  );
  if (!m) process.exit(0);

  // Detecção de force restrita a este push, até o próximo separador de shell.
  const tail = cmd.slice(m.index + m[0].indexOf(m[1]));
  const seg = tail.split(/&&|\|\||[;|\n]/)[0];
  const args = seg.replace(/^.*?push\b/, "");
  const forced =
    /--force\b/.test(seg) ||                            // --force, --force-with-lease, --force-if-includes
    /(?:^|\s)-[A-Za-z]*f[A-Za-z]*(?=\s|$)/.test(seg) || // -f ou flags curtas agrupadas com f
    /\s\+\S/.test(args);                                // +refspec (git push origin +main)
  if (!forced) process.exit(0);

  const reason =
    "Force-push negado por .claude/hooks/block-force-push.sh. Reescrever histórico é " +
    "proibido neste repositório (.claude/rules/git-workflow.md): quebra o invariante de " +
    "proveniência de docs/closeout.md. Se for mesmo necessário, a pessoa roda à mão, fora do Claude Code.";
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  }));
  process.stderr.write(reason + "\n");
  process.exit(2);
'
exit $?
