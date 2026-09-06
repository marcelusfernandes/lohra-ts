#!/bin/sh
# Extrai uma seção de um corpo Markdown (stdin): da linha `## <nome>` (ou
# `### <nome>`, se não houver `##`) até o próximo heading de nível IGUAL OU
# SUPERIOR — um `###` dentro de uma seção `##` fica; a última seção do corpo
# vai até o fim (nada de `sed '1d;$d'`, que perdia a última linha). Linhas em
# branco são removidas. Comparação do nome é literal (prefixo), como antes.
# Usado por open-pr.sh (#79); bancada em tests/claude-skills-scripts.test.ts.
# Uso: secao.sh "<nome>" < corpo
set -eu
[ $# -eq 1 ] || { echo "secao: uso: secao.sh \"<nome>\" < corpo" >&2; exit 2; }
NOME=$1
CORPO=$(cat)

extrair() {
  # $1 = nível do heading (2 ou 3)
  printf '%s\n' "$CORPO" | awk -v nome="$NOME" -v nivel="$1" '
    BEGIN { marca = ""; for (i = 0; i < nivel; i++) marca = marca "#"; marca = marca " " nome; dentro = 0 }
    {
      if (!dentro) {
        if (substr($0, 1, length(marca)) == marca) dentro = 1
        next
      }
      if (match($0, /^#+ /)) { if (RLENGTH - 1 <= nivel) exit }
      if ($0 ~ /^[[:space:]]*$/) next
      print
    }'
}

OUT=$(extrair 2)
[ -n "$OUT" ] || OUT=$(extrair 3)
[ -n "$OUT" ] && printf '%s\n' "$OUT"
exit 0
