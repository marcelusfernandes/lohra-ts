#!/bin/sh
# Extrai uma seção de um corpo Markdown (stdin): da linha `## <nome>` (ou
# `### <nome>`, se não houver `##`) até o próximo heading de nível IGUAL OU
# SUPERIOR — um `###` dentro de uma seção `##` fica; a última seção do corpo
# vai até o fim. Linhas em branco são removidas. Usado por open-pr.sh (#79).
# Uso: secao.sh "<nome>" < corpo
set -eu
echo "secao: not implemented (#79)" >&2
exit 2
