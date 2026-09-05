#!/bin/sh
# Cria uma issue completa: valida o padrão de seções, deriva complexity:* do
# header "Tamanho", cria via gh, liga ao épico pai por sub-issue NATIVA e
# imprime a URL. Uso:
#   create-issue.sh --title T --body-file F --milestone M [--labels a,b] [--parent N] [--repo o/r] [--dry-run]
set -eu

REPO="marcelusfernandes/lohra-ts"; TITLE=""; BODY=""; MILESTONE=""; LABELS=""; PARENT=""; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --title) TITLE=$2; shift 2 ;;
    --body-file) BODY=$2; shift 2 ;;
    --milestone) MILESTONE=$2; shift 2 ;;
    --labels) LABELS=$2; shift 2 ;;
    --parent) PARENT=$2; shift 2 ;;
    --repo) REPO=$2; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "create-issue: argumento desconhecido: $1" >&2; exit 2 ;;
  esac
done
[ -n "$TITLE" ] && [ -n "$BODY" ] && [ -n "$MILESTONE" ] || { echo "create-issue: --title, --body-file e --milestone são obrigatórios" >&2; exit 2; }
[ -f "$BODY" ] || { echo "create-issue: corpo não encontrado: $BODY" >&2; exit 2; }

# 1. padrão de seções (fail-closed: falta uma, não cria)
for s in "## User Story" "## Contexto" "## Cenário atual" "## Problema" "## Consequências do problema" "## O que é a solução" "## Resultado esperado com a solução" "## Acceptance Criteria" "## Fora de escopo" "## Referências"; do
  grep -q "^$s" "$BODY" || { echo "create-issue: seção ausente no corpo: $s" >&2; exit 2; }
done

# 2. complexity:* derivada do header — única fonte
SIZE=$(sed -n 's/^> \*\*Tamanho:\*\* *\([SML]\).*/\1/p' "$BODY" | head -1)
[ -n "$SIZE" ] || { echo "create-issue: header '> **Tamanho:** S|M|L — …' ausente" >&2; exit 2; }
LABELS="complexity:$SIZE${LABELS:+,$LABELS}"

set -- gh issue create --repo "$REPO" --title "$TITLE" --body-file "$BODY" --milestone "$MILESTONE"
for l in $(printf '%s' "$LABELS" | tr ',' ' '); do set -- "$@" --label "$l"; done

if [ "$DRY" -eq 1 ]; then
  printf 'dry-run: %s\n' "$*"
  [ -n "$PARENT" ] && printf 'dry-run: gh api -X POST repos/%s/issues/%s/sub_issues -F sub_issue_id=<id de #novo>\n' "$REPO" "$PARENT"
  exit 0
fi

URL=$("$@" | tail -1)
NUM=${URL##*/}
if [ -n "$PARENT" ]; then
  ID=$(gh api "repos/$REPO/issues/$NUM" --jq .id)
  gh api -X POST "repos/$REPO/issues/$PARENT/sub_issues" -F sub_issue_id="$ID" >/dev/null \
    || { echo "create-issue: issue #$NUM criada, mas o vínculo com #$PARENT FALHOU" >&2; exit 1; }
fi
echo "$URL"
