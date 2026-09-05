#!/bin/sh
# Abre a PR da branch atual contra main, ligada à issue: body no template com
# `Closes #N` em texto puro e os Acceptance Criteria da issue como checklist;
# labels e milestone herdados; verificação pós-criação via gh pr view --json.
# Uso: open-pr.sh --issue N [--title T] [--repo o/r] [--dry-run]
set -eu
REPO="marcelusfernandes/lohra-ts"; ISSUE=""; TITLE=""; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --issue) ISSUE=$2; shift 2 ;;
    --title) TITLE=$2; shift 2 ;;
    --repo) REPO=$2; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "open-pr: argumento desconhecido: $1" >&2; exit 2 ;;
  esac
done
[ -n "$ISSUE" ] || { echo "open-pr: --issue N é obrigatório (regra issue-first)" >&2; exit 2; }
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" != "main" ] || { echo "open-pr: não se abre PR a partir da main" >&2; exit 2; }

# issue: título, labels, milestone, bloco de Acceptance Criteria
META=$(gh issue view "$ISSUE" --repo "$REPO" --json title,labels,milestone,body)
ITITLE=$(printf '%s' "$META" | jq -r .title)
LABELS=$(printf '%s' "$META" | jq -r '.labels | map(.name) | join(",")')
MILESTONE=$(printf '%s' "$META" | jq -r '.milestone.title // empty')
AC=$(printf '%s' "$META" | jq -r .body | sed -n '/^## Acceptance Criteria/,/^## /p' | sed '1d;$d' | grep '^- \[' || true)
[ -n "$AC" ] || { echo "open-pr: a issue #$ISSUE não tem bloco '## Acceptance Criteria' com itens" >&2; exit 2; }
[ -n "$TITLE" ] || TITLE=$ITITLE

BODY=$(mktemp)
{
  echo "## Resumo"; echo
  echo "<!-- preencher: o que muda e por quê -->"; echo
  echo "Closes #$ISSUE"; echo
  echo "## Test plan"; echo
  echo '- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test` verdes'
  echo "- [ ] <execução real relevante>"; echo
  echo "## Acceptance Criteria (copiados da issue #$ISSUE)"; echo
  printf '%s\n' "$AC"
} > "$BODY"

set -- gh pr create --repo "$REPO" --base main --head "$BRANCH" --title "$TITLE" --body-file "$BODY"
[ -n "$MILESTONE" ] && set -- "$@" --milestone "$MILESTONE"
for l in $(printf '%s' "$LABELS" | tr ',' ' '); do set -- "$@" --label "$l"; done

if [ "$DRY" -eq 1 ]; then
  printf 'dry-run: %s\n' "$*"; echo "dry-run: body ↓"; cat "$BODY"; rm -f "$BODY"; exit 0
fi

URL=$("$@" | tail -1); rm -f "$BODY"
NUM=${URL##*/}
CHECK=$(gh pr view "$NUM" --repo "$REPO" --json closingIssuesReferences,labels,milestone)
printf '%s' "$CHECK" | jq -e --argjson n "$ISSUE" '.closingIssuesReferences | map(.number) | index($n) != null' >/dev/null \
  || { echo "open-pr: PR $URL criada, mas #$ISSUE NÃO está em closingIssuesReferences — fechamento automático não vai funcionar" >&2; exit 1; }
printf '%s' "$CHECK" | jq -r '"  closes=\(.closingIssuesReferences|map(.number)|join(","))  labels=\(.labels|map(.name)|join(","))  milestone=\(.milestone.title // "-")"'
echo "$URL"
