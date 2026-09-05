#!/bin/sh
# Cria/atualiza o ruleset da main — camada 3 da proteção (ADR 0004 item 9: é gate
# humano; o owner roda). Idempotente: se já existe um ruleset com este nome, faz PUT.
#
#   PR obrigatória (0 aprovações humanas — o revisor é agente e a label é a
#   condição; ver protege-main.sh), checks required `checks (20)`, `checks (22)`,
#   `provenance`, sem force-push (non_fast_forward), sem delete.
#
# Uso: scripts/github/ruleset.sh [owner/repo]
set -eu
REPO="${1:-marcelusfernandes/lohra-ts}"
NAME="protege-main"
BODY=$(cat <<'JSON'
{
  "name": "protege-main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["merge"] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "checks (20)" },
          { "context": "checks (22)" },
          { "context": "provenance" } ] } }
  ]
}
JSON
)
ID=$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name==\"$NAME\") | .id" 2>/dev/null || true)
if [ -n "$ID" ]; then
  printf '%s' "$BODY" | gh api -X PUT "repos/$REPO/rulesets/$ID" --input - --jq '"ruleset atualizado: #\(.id) \(.name) [\(.enforcement)]"'
else
  printf '%s' "$BODY" | gh api -X POST "repos/$REPO/rulesets" --input - --jq '"ruleset criado: #\(.id) \(.name) [\(.enforcement)]"'
fi
