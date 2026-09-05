#!/bin/sh
# Stop hook: roda o type-checker uma vez no fim do turno.
#
# Com erro de tipo, devolve as primeiras linhas em stderr e sai com exit 2 —
# o agente continua até o projeto type-checkar limpo ("loop until green").
# Seguro como gate porque o baseline de `npm run typecheck` é verde; só erros
# introduzidos no turno bloqueiam. Portado do Marvinz (lá é `tsc -b`, aqui
# `tsc --noEmit` porque tsconfig.json não usa project references).
#
# Sem stdin (Stop não carrega arquivo). Fail-open se o tsc local não existir.
set -u
project_dir="${CLAUDE_PROJECT_DIR:-$PWD}"
tsc_bin="$project_dir/node_modules/.bin/tsc"
[ -x "$tsc_bin" ] || exit 0
cd "$project_dir" || exit 0

out=$("$tsc_bin" --noEmit 2>&1)
code=$?
if [ "$code" -ne 0 ]; then
  printf '%s\n' "$out" | head -40 >&2
  echo "tsc-check: erros de tipo (acima). Corrija antes de encerrar o turno." >&2
  exit 2
fi
exit 0
