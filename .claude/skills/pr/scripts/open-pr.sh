#!/bin/sh
# Abre a PR da branch atual contra main, ligada à issue: body no template com
# `Closes #N` em texto puro, os Acceptance Criteria da issue como checklist e as
# seções `## Proof` e `## Files` copiadas (aviso se a issue for anterior a #44);
# labels e milestone herdados; verificação pós-criação via gh pr view --json.
# Uso: open-pr.sh --issue N [--issue M ...] [--refs K ...] [--title T] [--repo o/r] [--dry-run]
# A primeira --issue dá título, labels e milestone; os AC de todas viram checklist.
set -eu
REPO="marcelusfernandes/lohra-ts"; ISSUES=""; REFS=""; TITLE=""; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --issue) ISSUES="$ISSUES $2"; shift 2 ;;
    --refs) REFS="$REFS $2"; shift 2 ;;
    --title) TITLE=$2; shift 2 ;;
    --repo) REPO=$2; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "open-pr: argumento desconhecido: $1" >&2; exit 2 ;;
  esac
done
[ -n "$ISSUES" ] || { echo "open-pr: --issue N é obrigatório (regra issue-first)" >&2; exit 2; }
FIRST=${ISSUES# }; FIRST=${FIRST%% *}
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" != "main" ] || { echo "open-pr: não se abre PR a partir da main" >&2; exit 2; }

# primeira issue: título, labels, milestone
META=$(gh issue view "$FIRST" --repo "$REPO" --json title,labels,milestone)
ITITLE=$(printf '%s' "$META" | jq -r .title)
# labels de tipo/complexidade sim; estado (state:*), estrutura (epic), gate (human) e
# veredito (review:*) são da issue, não da PR (follow-up das PRs #30/#37, issue #35)
LABELS=$(printf '%s' "$META" | jq -r '.labels | map(.name) | map(select(test("^(state:|review:)") | not)) | map(select(. != "epic" and . != "human")) | join(",")')
MILESTONE=$(printf '%s' "$META" | jq -r '.milestone.title // empty')
[ -n "$TITLE" ] || TITLE=$ITITLE

BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT
{
  echo "## Resumo"; echo
  echo "<!-- preencher: o que muda e por quê -->"; echo
  for n in $ISSUES; do echo "Closes #$n"; done
  for n in $REFS; do echo "Refs #$n"; done
  echo
  echo "## Test plan"; echo
  echo '- [ ] `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test` verdes'
  echo "- [ ] dogfooding real (Codex e/ou OpenRouter): exit 0, error null, tool_calls"; echo
  for n in $ISSUES; do
    IBODY=$(gh issue view "$n" --repo "$REPO" --json body -q .body)
    # secao.sh (#79): `##` ou `###` (formulário issue.yml); vai até o próximo
    # heading de nível igual ou superior (um `###` interno fica) ou até o fim
    # do corpo (a última seção não perde a última linha).
    secao() { printf '%s\n' "$IBODY" | sh "$(dirname "$0")/secao.sh" "$1"; }
    AC=$(secao "Acceptance Criteria" | grep '^- \[' || true)
    [ -n "$AC" ] || { echo "open-pr: a issue #$n não tem bloco '## Acceptance Criteria' com itens" >&2; exit 2; }
    echo "## Acceptance Criteria (copiados da issue #$n)"; echo; printf '%s\n' "$AC"; echo
    # Proof e Files (issue #44): copiados da issue; issue anterior ao padrão só avisa
    PROOF=$(secao "Proof" || true); FILES=$(secao "Files" || true)
    [ -n "$PROOF" ] || echo "open-pr: aviso — a issue #$n não tem '## Proof' (anterior ao padrão #44); preencha na PR" >&2
    [ -n "$FILES" ] || echo "open-pr: aviso — a issue #$n não tem '## Files' (anterior ao padrão #44); preencha na PR" >&2
    echo "## Proof (da issue #$n)"; echo
    printf '%s\n' "${PROOF:-<!-- a issue não declara Proof; declare aqui o comando -->}"; echo
    echo '<!-- cole `.prova/<slug>/resumo.json` abaixo, ou "N/A — classe docs/process sem prova executável" e o que a substitui -->'
    echo '```json'; echo '```'; echo
    echo "## Files (da issue #$n)"; echo
    printf '%s\n' "${FILES:-<!-- a issue não declara Files; liste os globs tocados -->}"; echo
  done
} > "$BODY"

set -- gh pr create --repo "$REPO" --base main --head "$BRANCH" --title "$TITLE" --body-file "$BODY"
[ -n "$MILESTONE" ] && set -- "$@" --milestone "$MILESTONE"
OLDIFS=$IFS; IFS=','; for l in $LABELS; do [ -n "$l" ] && set -- "$@" --label "$l"; done; IFS=$OLDIFS

if [ "$DRY" -eq 1 ]; then
  printf 'dry-run: %s\n' "$*"; echo "dry-run: body ↓"; cat "$BODY"; exit 0
fi

OUT=$("$@")
URL=$(printf '%s\n' "$OUT" | tail -1)
NUM=${URL##*/}
CHECK=$(gh pr view "$NUM" --repo "$REPO" --json closingIssuesReferences,labels,milestone)
for n in $ISSUES; do
  printf '%s' "$CHECK" | jq -e --argjson n "$n" '.closingIssuesReferences | map(.number) | index($n) != null' >/dev/null \
    || { echo "open-pr: PR $URL criada, mas #$n NÃO está em closingIssuesReferences — fechamento automático não vai funcionar" >&2; exit 1; }
done
printf '%s' "$CHECK" | jq -r '"  closes=\(.closingIssuesReferences|map(.number)|join(","))  labels=\(.labels|map(.name)|join(","))  milestone=\(.milestone.title // "-")"'
echo "$URL"
