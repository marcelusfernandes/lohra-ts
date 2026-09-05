#!/bin/sh
# Cria/atualiza as labels de triagem do repositório. Idempotente: `gh label create --force`
# atualiza cor e descrição se a label já existe. Convenção herdada do repo Python
# (marcelusfernandes/lohra): complexidade e severidade NÃO determinam ordem de roadmap.
set -eu
REPO="${1:-marcelusfernandes/lohra-ts}"
mk() { gh label create "$1" --repo "$REPO" --color "$2" --description "$3" --force >/dev/null && echo "label: $1"; }

mk "epic"             "3E4B9E" "Épico: agrupa sub-issues de um milestone; fecha quando todas fecham"
mk "investigation"    "FBCA04" "Exige validação cética antes de implementação permanente"
mk "complexity:S"     "C2E0C6" "Cabe em 1 sessão curta: fix cirúrgico em 1-2 arquivos ou refactor mecânico"
mk "complexity:M"     "FEF2C0" "Cabe em 1 sessão média: cross-layer simples ou refactor com decisões"
mk "complexity:L"     "F9D0C4" "Múltiplas sessões ou squad com gates humanos"
mk "severity:critical" "B60205" "Severidade crítica de review independente; não determina ordem de roadmap"
mk "severity:high"    "D93F0B" "Severidade alta de review independente; não determina ordem de roadmap"
mk "severity:medium"  "E99695" "Severidade média de review independente; não determina ordem de roadmap"
mk "independence:I1"  "BFD4F2" "Dependência de sequência: deve seguir trabalho pré-requisito"
mk "independence:I2"  "C5DEF5" "Algum acoplamento ou provável sobreposição de arquivos"
mk "independence:I3"  "0E8A16" "Altamente independente; adequado a trabalho paralelo"
