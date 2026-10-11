# #847 — home das fixtures doctor e providers

O baseline `58fa34e5eb4863ddb77a147c49fff25d323f8002` foi medido em
clones descartáveis separados no volume F:, com dependências próprias para
Node 20.20.2 e Node 22.23.2. O foco conjunto de `tests/cli-doctor.test.ts`
e `tests/providers.test.ts` teve **3 falhas e 24 passes** em cada ABI:

| Caso                             | Contrato esperado                          | Resultado no Windows antes do ajuste                          |
| -------------------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| Subscription ativa + chave       | URL inicia em `CODEX_PROVIDER.baseUrl`     | a URL interceptada não inicia nesse prefixo                   |
| Preferência subscription inativa | doctor exit 2, rota inutilizável           | doctor exit 0                                                 |
| Tiers válidos                    | `small: openai/m/low` e `big: anthropic/b` | informou `workflow_tiers.json — not configured` em outro home |

Nos dois casos doctor, a fixture escrevia estado em `join(base, ".lohra")`
por `enable`/`writeTokens` ou `setPreference`, mas o ambiente entregue a
`runCli` tinha só `HOME: base`. A fixture de tiers também gravava
`workflow_tiers.json` em `join(home, ".lohra")` e passava só `HOME`.
O default Windows de `LOHRA_HOME` apontou para outro diretório, o que
explica as rotas e o arquivo ausente sem mudar a política do produto.

O commit vermelho compilável `3312f02` adicionou asserts de identidade do
home (e de `CODEX_HOME` nos cenários doctor) e declarou a prova dos dois
arquivos. `typecheck` passou e o foco permaneceu vermelho (3/27) em Node 20;
o baseline já havia reproduzido as mesmas três falhas em ambas as ABIs.
No commit verde `2edd661`, os ambientes dos três cenários recebem
`LOHRA_HOME` exatamente igual ao diretório de escrita. Os dois cenários
doctor também recebem `CODEX_HOME` temporário próprio sem `config.toml` nem
login do operador. Todos os 27 testes focais passaram em Node 20/22.

Os stubs de HTTP locais, a interceptação de `NativeChatHttpPort.post` e o
`probeOllama` permaneceram intactos. O teste mantém URL Codex, modelo
`gpt-5.5`, erro de preferência, ausência de warning e bytes/exit dos tiers
como assertions originais; não houve credencial real nem provider externo.
Logs nativos sanitizados estão em `F:/lohra-m25-847/{baseline,red,green,node20,node22}-*.log`.
Os clones Windows partiram da base com overlay apenas de testes/prova;
os arquivos medidos têm hashes idênticos ao candidato.

No Linux, clone separado do bundle do commit `2edd661`, usuário `node` e
HOME/TMPDIR próprios: `npm ci` e os cinco gates passaram. A suíte completa
teve **340 arquivos e 4.484 testes aprovados, com 8 skips**; a prova passou
27/27. O controle negativo saiu 0 com `SKIP` mecânico por diff só de
testes/prova, sem alegação de assertion-red. O vermelho causal foi medido
no baseline e no commit `test(red)` acima. Logs e códigos de saída estão em
`F:/lohra-m25-847/linux-gates/`. Esta nota foi acrescentada depois dos
gates, sem mudar bytes dos testes ou da prova; o `format:check` final cobre
também a nota.
