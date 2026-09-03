# Gate de decisão T22

Data: 2026-09-03

## Decisão

O `lohra-ts` passa a ser a linha principal do novo capítulo do produto
(`typescript-mainline`). O runtime Python permanece como oracle semântico
read-only durante a transição, não como dependência de execução ou destino de
novas implementações deste repositório.

Esta decisão foi tomada pelo owner após a integração dos tickets T00–T21 no
T22 e a validação local da aplicação empacotada em macOS arm64 com Node 20 e
Node 22.

## Fronteiras

- Semânticas continuam derivadas do Python pinado e de `docs/reference/`.
- O package público TypeScript não pode depender de Python em instalação ou
  execução.
- Divergências deliberadas de segurança permanecem normativas: promoção de
  `sub_id` é recusada e colisões MCP revertem o lote atomicamente.
- Providers e SDKs live sem credenciais continuam `NOT_MEASURED`; evidence
  offline não pode ser promovida a live.
- A matriz Windows nativa permanece `NOT_MEASURED` como pendência explícita do
  closeout. Não será substituída por spoof ou cross-build.

## Evidência usada

- Os 22 SHAs aprovados T00–T21 são ancestrais da branch integrada T22.
- Gates locais: typecheck, lint, build, formato, package e 1.475 testes.
- macOS arm64: Node 20.19.3 e Node 22.22.3 com instalação offline, scripts
  habilitados, tarball público, `node-pty` nativo e zero Python no runtime.
- Closeout de mutações T15–T22: duas execuções por lane, zero sobreviventes;
  T22 com 18/18 mutantes mortos.

## Critérios de reavaliação

A decisão deve ser reaberta se uma validação nativa Windows revelar um blocker
P0/P1, se o package TypeScript voltar a depender de Python, ou se uma regressão
quebrar os invariantes de falha explícita, bounded work ou lease/fence.

## Preservação do documento local

O arquivo local preexistente `docs/gate-decision.md` não foi lido, copiado ou
alterado durante o T22. Este registro usa um novo path versionado por decisão
explícita do owner.
