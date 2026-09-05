#!/bin/sh
# PreToolUse hook (Edit|Write): nega escrita em documentação congelada.
#
#   docs/reference/**  — documentação histórica do Python; não editar (CLAUDE.md)
#   lohra/**           — checkout do Python, gitignorado, somente leitura (CLAUDE.md)
#
# Sem válvula: esses diretórios são referência, nunca destino. Resolve o ancestral
# EXISTENTE mais próximo do alvo por realpath antes de julgar (um symlink fora do
# worktree que resolve para dentro de docs/reference/ é fuga e é negado); alvo
# genuinamente fora do worktree (scratchpad em /tmp) é permitido. Fail-closed se
# não der para canonicalizar cwd. Portado do Apollo (protege-escrita.sh), sem as
# regras de dono único que não existem aqui.
set -u
payload=$(cat)
# FAIL-CLOSED sem node: este hook é a ÚNICA camada que protege docs/reference/ e
# lohra/ (não há pre-push, ruleset nem Action para escrita de arquivo).
if ! command -v node >/dev/null 2>&1; then
  reason="Bloqueado por .claude/hooks/protege-escrita.sh: node ausente no PATH; nego por segurança (fail-closed)."
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}' "$reason"
  echo "$reason" >&2; exit 2
fi

PE_PAYLOAD="$payload" node -e '
  const { spawnSync } = require("child_process");
  const fs = require("fs");
  const path = require("path");
  const raw = process.env.PE_PAYLOAD || "";
  let j; try { j = JSON.parse(raw); } catch { process.exit(0); }
  if (!["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(j.tool_name)) process.exit(0);
  const filePath = j.tool_input && (j.tool_input.file_path || j.tool_input.notebook_path);
  if (!filePath) process.exit(0);
  const cwd = j.cwd || process.cwd();

  const negar = (motivo) => {
    const reason = "Bloqueado por .claude/hooks/protege-escrita.sh: " + motivo + " Ver CLAUDE.md (convenções).";
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
    process.stderr.write(reason + "\n");
    process.exit(2);
  };
  const realpath = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

  const cwdReal = realpath(cwd);
  if (cwdReal === null) negar("não consegui resolver o caminho real de cwd (" + cwd + "); nego por segurança.");
  // Raiz das regras (issue #61): calculada a partir do ALVO, não do cwd — o
  // toplevel git mais INTERNO, subindo, que contenha .claude/settings.json.
  // Dentro de um worktree de agente (.claude/worktrees/<x>) a raiz é o worktree,
  // senão `.claude/worktrees/x/docs/reference/…` não casaria; dentro de lohra/
  // (repo git aninhado, sem settings) a raiz é o projeto. Sem nenhum toplevel com
  // settings: CLAUDE_PROJECT_DIR se o alvo está dentro dele; senão o toplevel mais
  // externo; senão null (fora de qualquer repo).
  function toplevels(start) {
    const tops = [];
    let dir = start;
    for (;;) {
      const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" });
      if (r.status !== 0) break;
      const top = realpath(r.stdout.trim()) || r.stdout.trim();
      tops.push(top);
      const parent = path.dirname(top);
      if (parent === top) break;
      dir = parent;
    }
    return tops;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR ? realpath(process.env.CLAUDE_PROJECT_DIR) : null;
  function rootFor(dir) {
    if (dir === null || !fs.existsSync(dir)) return null;
    const tops = toplevels(dir);
    for (const t of tops) if (fs.existsSync(path.join(t, ".claude", "settings.json"))) return t;
    if (projectDir && (dir === projectDir || dir.startsWith(projectDir + path.sep))) return projectDir;
    return tops.length ? tops[tops.length - 1] : null;
  }

  function resolveExistingAncestor(absolutePath) {
    let dir = path.dirname(absolutePath);
    const remainder = [path.basename(absolutePath)];
    for (;;) {
      const real = realpath(dir);
      if (real !== null) return path.join(real, ...remainder);
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      remainder.unshift(path.basename(dir));
      dir = parent;
    }
  }
  function toCanonicalPrefix(absolutePath) {
    if (absolutePath === cwd) return cwdReal;
    if (absolutePath.startsWith(cwd + path.sep)) return path.join(cwdReal, absolutePath.slice(cwd.length + 1));
    return absolutePath;
  }

  const abs = path.isAbsolute(filePath) ? toCanonicalPrefix(filePath) : path.resolve(cwdReal, filePath);
  const absReal = resolveExistingAncestor(abs);
  if (absReal === null) negar("não consegui resolver nenhum ancestral existente do alvo (" + abs + "); nego por segurança.");
  const root = rootFor(path.dirname(absReal));
  if (root === null) {
    // resolvido fora de qualquer repo: permitido — salvo se o caminho TEXTUAL está
    // dentro de um repo (symlink que foge para fora), que é negado por segurança
    const rootTextual = rootFor(fs.existsSync(path.dirname(abs)) ? path.dirname(abs) : null);
    if (rootTextual !== null) negar("o alvo (" + filePath + ") parece estar dentro do worktree, mas um ancestral é symlink que resolve para fora (" + absReal + "); nego por segurança.");
    process.exit(0); // genuinamente fora do worktree (scratchpad): sempre permitido
  }
  const rel = path.relative(root, absReal).split(path.sep).join("/");
  if (rel === "docs/reference" || rel.startsWith("docs/reference/"))
    negar("docs/reference/ é documentação histórica congelada; não se edita.");
  if (rel === "lohra" || rel.startsWith("lohra/"))
    negar("lohra/ é o checkout do Python, somente leitura; não se implementa nem se edita nele.");
  process.exit(0);
'
exit $?
