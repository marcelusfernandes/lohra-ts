#!/bin/sh
# Copia .claude/hooks/git-pre-push para o diretório de hooks do git deste clone
# (funciona de dentro de um worktree: `git rev-parse --git-path hooks` resolve
# para o diretório comum). .git/hooks não é versionado, então todo clone nasce
# sem a trava; scripts/postinstall.mjs chama este script quando há um checkout
# git (instalação por tarball, sem .git, pula em silêncio — não é um clone).
# Idempotente: compara bytes antes de copiar.
set -eu
raiz=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "instalar-git-hooks: fora de um checkout git; nada a instalar"; exit 0; }
origem="$raiz/.claude/hooks/git-pre-push"
destino_dir=$(git rev-parse --git-path hooks)
destino="$destino_dir/pre-push"
[ -f "$origem" ] || { echo "instalar-git-hooks: $origem não existe" >&2; exit 1; }
mkdir -p "$destino_dir"
if [ -f "$destino" ] && cmp -s "$origem" "$destino"; then
  echo "pre-push já instalado e em dia: $destino"; exit 0
fi
cp "$origem" "$destino"; chmod +x "$destino"
echo "pre-push instalado: $destino"
