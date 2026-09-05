#!/bin/sh
# PostToolUse hook (Edit|Write): formata e aplica lint --fix no arquivo tocado.
#
# Recebe o JSON do hook por stdin e extrai o caminho do arquivo com node (o
# projeto já exige Node; não dependemos de jq no PATH do hook). Nunca bloqueia
# a edição (exit 0 sempre) e nunca engole stderr: um erro de lint que o --fix
# não resolve aparece no transcript, mas não impede a edição intermediária.
#
# Teste por pipe:
#   echo '{"tool_input":{"file_path":"/abs/src/x.ts"}}' | .claude/hooks/format-file.sh
set -u

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
FILE=$(node -e '
  let raw = "";
  process.stdin.on("data", (c) => { raw += c; });
  process.stdin.on("end", () => {
    let path = "";
    try {
      const j = JSON.parse(raw);
      path = (j.tool_response && j.tool_response.filePath) || (j.tool_input && j.tool_input.file_path) || "";
    } catch (error) {
      process.stderr.write(`format-file: stdin não é JSON de hook: ${String(error)}\n`);
    }
    process.stdout.write(path);
  });
')

[ -n "$FILE" ] || exit 0
[ -f "$FILE" ] || exit 0

cd "$ROOT" || exit 0

# --ignore-unknown: extensões que o prettier não conhece são puladas em silêncio;
# .prettierignore continua valendo (docs/reference/, lohra/, SKILL.md grandes).
npx prettier --write --ignore-unknown --log-level warn "$FILE" \
  || echo "format-file: prettier falhou em $FILE" >&2

case "$FILE" in
  *.ts|*.mts|*.cts|*.js|*.mjs|*.cjs)
    # --no-warn-ignored: arquivo coberto pelos ignores do eslint.config.js não vira aviso.
    npx eslint --fix --no-warn-ignored "$FILE" \
      || echo "format-file: eslint deixou erros não corrigíveis em $FILE (ver acima)" >&2
    ;;
esac

exit 0
