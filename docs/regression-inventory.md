# Inventário de regressão

Arquivo novo (issue #153, passo 0f do épico #13). A #163 (8-S1) escreve o
resto do inventário — o corpus completo de fixtures/scripts de regressão que
substitui a validação bilateral contra o Python (`docs/gate-decision-t22.md`).
Esta seção nasce aqui porque a triagem do catálogo de mutação de
`scripts/parity/closeout/run-closeout-mutations.ts` (35 mutantes) é um
pré-requisito do #8 (apagar `scripts/parity/closeout/`): 8 mutantes de `src/`
migraram para `scripts/mutations/self-update.ts` (`npm run
mutations:self-update`); os outros 27 são aposentados aqui, com id, alvo e
motivo, para que apagar o diretório não perca rastro de mutante nenhum.

## Mutantes aposentados com #8

Nenhum destes mira `src/`: todos miram um artefato exclusivo do próprio
processo de closeout T22 — o diretório `scripts/parity/closeout/`, outro
script do diretório histórico de paridade, ou `README.md`/`package.json`
sobre esse processo. Quando `scripts/parity/closeout/` sair (#8/#167), o
comportamento que cada um verificava deixa de existir junto — não há
substituto porque não sobra nada para substituir.

| id                                          | alvo                                                | motivo                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `T22-ancestor-inventory`                    | `scripts/parity/closeout/verify-evidence.ts`        | Âncora quebrada desde #158: o mutante trocava o SHA de T00 hardcoded em `verify-evidence.ts`, que agora importa `approvedHeadPairs()` de `docs/provenance.json` — a âncora tem 0 ocorrências e `npm run mutations:closeout` já abortava com `MUTATION_ANCHOR` num checkout com o oráculo presente. Não é re-ancorado em `docs/provenance.json` porque o comando inteiro (`mutations:closeout`) está sendo aposentado por esta issue, não migrado. |
| `T22-tarball-python`                        | `package.json` (lista de arquivos do pacote npm)    | Verifica que o tarball publicado não inclui um arquivo Python — checagem do processo de empacotamento do closeout T22 (`no-python.ts`), não de `src/`.                                                                                                                                                                                                                                                                                            |
| `T22-script-omitted`                        | `package.json` (script `probe:t22:security`)        | Verifica que o inventário de scripts de paridade (`run-closeout.ts --check-only`) rejeita um script de closeout ausente — o próprio inventário some com #8.                                                                                                                                                                                                                                                                                       |
| `T22-normalization-broad`                   | `scripts/parity/closeout/normalization.ts`          | Normalização de telemetria da saída do closeout (mascarar timestamps voláteis do agregador) — não existe fora do agregador.                                                                                                                                                                                                                                                                                                                       |
| `T22-vitest-parallel-telemetry`             | `scripts/parity/closeout/normalization.ts`          | Idem: normaliza ordem de conclusão paralela do Vitest só na saída do agregador de closeout.                                                                                                                                                                                                                                                                                                                                                       |
| `T22-t16-lock-wait-telemetry`               | `scripts/parity/closeout/normalization.ts`          | Idem: normaliza `waitedForLockMs` só no resumo estruturado que o closeout T16 produzia para o agregador.                                                                                                                                                                                                                                                                                                                                          |
| `T22-t18-scheduler-evidence-telemetry`      | `scripts/parity/closeout/normalization.ts`          | Idem: normaliza hash de evidência do scheduler T18 só na saída do agregador.                                                                                                                                                                                                                                                                                                                                                                      |
| `T22-t12-coalesced-boot-output`             | `scripts/parity/gateway/launch-candidate-fake.ts`   | Fixture de boot do candidato de gateway usada só pelos cenários bilaterais de paridade T12.                                                                                                                                                                                                                                                                                                                                                       |
| `T22-t13-nested-t10-timeout`                | `scripts/parity/orchestration/run-gates.ts`         | Orçamento de timeout do gate aninhado T10 dentro do gate T13 — ambos scripts de paridade, sem equivalente em `src/`.                                                                                                                                                                                                                                                                                                                              |
| `T22-t13-nested-t10-timeout-wiring`         | `scripts/parity/orchestration/run-gates.ts`         | Idem: fiação do orçamento acima ao comando real `parity:t10:gates`.                                                                                                                                                                                                                                                                                                                                                                               |
| `T22-t19-test-stream-order`                 | `scripts/parity/mcp/run-regression-gates-locked.sh` | Ordem de stream de diagnóstico do gate T19 (script de shell do diretório histórico de paridade).                                                                                                                                                                                                                                                                                                                                                  |
| `T22-t19-serial-test-suite`                 | `scripts/parity/mcp/run-regression-gates-locked.sh` | Idem: força a suíte T19 a rodar serial (`--no-file-parallelism --maxWorkers=1`) só dentro desse gate de paridade.                                                                                                                                                                                                                                                                                                                                 |
| `T22-t19-dashboard-port-isolation`          | `scripts/parity/mcp/run-regression-gates-locked.sh` | Isolamento da porta do dashboard do usuário no gate de shell T19.                                                                                                                                                                                                                                                                                                                                                                                 |
| `T22-t19-scenario-dashboard-port-isolation` | `scripts/parity/mcp/harness.ts`                     | Mesmo isolamento de porta, agora no harness de cenários T19 (não no gate de shell).                                                                                                                                                                                                                                                                                                                                                               |
| `T22-t17-dashboard-port-isolation`          | `scripts/parity/workflow-audit-live/support.ts`     | Mesmo isolamento de porta, no suporte de cenários do T17 de paridade.                                                                                                                                                                                                                                                                                                                                                                             |
| `T22-fixed-port`                            | `scripts/parity/cli.ts`                             | Aloca porta dinâmica (em vez de `11434` fixa) para o stub do oracle nos cenários bilaterais de paridade.                                                                                                                                                                                                                                                                                                                                          |
| `T22-candidate-dynamic-stub-redirect`       | `scripts/parity/stub/driver.ts`                     | Redireciona `PYTHONPATH` só no lado do stub do oracle Python dentro do driver de paridade.                                                                                                                                                                                                                                                                                                                                                        |
| `T22-concurrency-evidence`                  | `scripts/parity/closeout/evidence-validation.ts`    | Valida a evidência de concorrência (`E20_CONCURRENT_PARITY_GATES`) do agregador de closeout.                                                                                                                                                                                                                                                                                                                                                      |
| `T22-diff-check-gate`                       | `scripts/parity/closeout/evidence-validation.ts`    | Valida o gate `diffCheck` booleano estrito da evidência de gates do agregador de closeout.                                                                                                                                                                                                                                                                                                                                                        |
| `T22-platform-spoof`                        | `scripts/parity/closeout/verify-evidence.ts`        | Recusa `D16` (matriz nativa Windows) marcado como `PASS` — bloqueador de plataforma do closeout, não medido por este runtime.                                                                                                                                                                                                                                                                                                                     |
| `T22-docs-obsolete`                         | `README.md`                                         | Pino de versão (`0.0.11`) do README — assunto de `tests/t22-docs.test.ts`, não de mutação de comportamento de `src/`.                                                                                                                                                                                                                                                                                                                             |
| `T22-node20-sqlite-dependency`              | `package.json` (dependência `better-sqlite3`)       | Verifica que a versão nativa do SQLite continua compatível com o piso Node 20 declarado — checagem de manifesto do closeout, sem contraparte em `src/`.                                                                                                                                                                                                                                                                                           |
| `T22-aggregate-evidence`                    | `scripts/parity/closeout/verify-evidence.ts`        | Verifica que o agregado de evidência (`parityAggregatePass && mutationAggregatePass`) não é forçado para `true` — lógica do próprio verificador de closeout.                                                                                                                                                                                                                                                                                      |
| `T22-component-sha-binding`                 | `scripts/parity/closeout/evidence-validation.ts`    | Vincula cada componente de evidência ao SHA do candidato alvo — validação de evidência do closeout.                                                                                                                                                                                                                                                                                                                                               |
| `T22-owner-ruling-binding`                  | `scripts/parity/closeout/evidence-validation.ts`    | Vincula a decisão arquitetural do owner (`typescript-mainline`) ao texto do ruling — validação de evidência do closeout.                                                                                                                                                                                                                                                                                                                          |
| `T22-measured-test-floor`                   | `scripts/parity/closeout/evidence-validation.ts`    | Piso de contagem medida de testes (`gates.tests >= 1475`) — constante do processo de fechamento, cresce a cada suíte nova; não é comportamento de `src/`.                                                                                                                                                                                                                                                                                         |
| `T22-docs-architecture-decided`             | `README.md`                                         | Pino de texto sobre a decisão arquitetural já tomada — assunto de `tests/t22-docs.test.ts`.                                                                                                                                                                                                                                                                                                                                                       |

Total: 27 aposentados + 8 migrados (`T22-updater-shell`, `T22-updater-non-ff`,
`T22-updater-divergence-after-pull`, `T22-updater-host-cwd`,
`T22-node-pty-bypass`, `T22-mcp-last-wins`, `T22-l22-promotion-reopened`,
`T22-hotspot-workflow-handler`, hoje em `scripts/mutations/self-update.ts`) =
35, o total original de `run-closeout-mutations.ts`.

## Desvios declarados

- `scripts/parity/closeout/inventory.json:56,66` continuam apontando
  `mutations:t17` para `scripts/parity/workflow-audit-live/run-mutations.ts`
  e `parity:t20:mutations` para `scripts/parity/web-tools/run-mutations.ts`
  (ambos shims desde as issues #150/#152) e `meta` (linha 130) ainda lista
  `mutations:closeout`, que este PR remove de `package.json`. `inventory.json`
  não está no `## Files` desta issue — `run-closeout.ts --check-only`
  (`validateInventory`) passaria a lançar `INVENTORY_MISSING:mutations:closeout`
  se alguém o rodasse agora, mas nenhum gate deste repositório (`npm test`,
  `npm run prova`, CI) chama esse caminho hoje. Fica registrado para quem
  tocar `inventory.json` a seguir (#8/#167 apagam o arquivo inteiro; se algo
  precisar rodar antes disso, uma issue própria corrige as três entradas).
- `README.md:351` ainda lista `npm run mutations:closeout` no histórico do
  fechamento T22. `README.md` também não está no `## Files` desta issue;
  nenhum teste (`tests/t22-docs.test.ts` incluso) pina essa linha, então a
  suíte continua verde, mas o comando documentado não existe mais depois
  deste PR. Fica para o `documentador` (ou uma issue própria) atualizar a
  prosa.

## Inventário por lane

Issue #163 (8-S1). Base: `git ls-files scripts/parity | wc -l` = **556** no
HEAD `114c95c` (não 558 — o comentário de reconciliação de 2026-09-06 no #8
contou antes de #149 remover `workflow-durability/mutants-orchestration.ts`
e `mutants-types.ts`; `git log --diff-filter=D --name-only -- scripts/parity`
mostra as duas remoções no commit `8664452`). 556 = 326 JSON + 133 TS + 63 MJS

- 31 PY + 2 MTS + 1 SH + 1 MD + 1 CJS (`find scripts/parity -type f | sed
's/.*\.//' | sort | uniq -c`).

### Classe (o que o arquivo precisa para rodar)

- **D** — `scripts/parity/closeout/**`, precedência sobre as demais regras
  (artefato exclusivo do fechamento T22; arquivos fora de `closeout/` que
  também servem ao T22 mas precisam de oráculo caem em A, ex.
  `orchestration/run-gates.ts`).
- **C** — referencia `scripts/mutations` no próprio código-fonte:
  `grep -rl "scripts/mutations" scripts/parity` → 7 arquivos (os 6 shims
  `run-mutations.ts`/`run-closeout-mutations.ts` das #149-#153 mais
  `media/comparator.ts`, que reexporta `scripts/mutations/media-comparator.js`
  inteiro). Já migrados; o diretório fica só até o #167 apagar a árvore.
- **A** — exige o oráculo Python vivo para produzir um resultado que não seja
  trivialmente falho: todo arquivo `.py` (31 — um `.py` precisa do
  interpretador Python para rodar mesmo sem citar a palavra "oracle"; um
  deles, `cron/oracle-tool-runner.py`, só aparece com `grep` por import de
  pacote — `from lohra.agent.equip import ...` —, não por palavra), mais todo
  arquivo cujo código-fonte cita
  `python|oracle|ORACLE|LOHRA_ORACLE_WORKSPACE|oracle-venv|python_runner|sitecustomize`
  fora de uma menção sem relação com dependência real de oráculo — três
  falsos positivos descartados manualmente depois de ler o conteúdo:
  `normalization-fixture.mjs` (a palavra "oracle" é um literal de string do
  próprio fixture) e as três cópias de `ts-only-probes.mjs` (`tools/`,
  `local-context/`, `conversation/`), que só citam `pythonJsonDumps` — o
  serializador TS de `dist/serialization/python-json.js`, não o oráculo.
  `LOHRA_ORACLE_WORKSPACE` aparece em 5 arquivos, não 6 como no comentário do
  #8 (`grep -rl LOHRA_ORACLE_WORKSPACE scripts/parity`).
- **B** — todo o resto: dados de cenário/manifesto (`scenarios/`,
  `manifests/`), infra compartilhada da raiz importada por
  `tests/parity/*.test.ts`, e scripts só-candidato (`live-smoke.mjs`,
  `*-only-probes.mjs`, drivers de fixture) que não precisam do oráculo para
  rodar, tenham ou não teste hoje.

### Cobertura (`tests/`)

Coluna independente da classe: só registra se algo em `tests/` importa ou lê
o arquivo hoje.

- **"10 testes de `tests/`" do levantamento do #8 → 4 importadores reais**:
  `tests/gateway/launch-candidate.test.ts:11-13`,
  `raw-socket-primitives.test.ts:12,17`, `launch-candidate-argv.test.ts:37` e
  `tests/t22-closeout.test.ts` (import + `source()` de texto). Os outros seis
  (`ci-contratos`, `ci-controle-negativo-integracao`, `ci-escopo`,
  `helpers/controle-negativo-repo.ts`, `mutations-*-catalog.test.ts`,
  `orchestration-child-runner-mutation-catalog.test.ts`, `web-html-entities`)
  só citam `scripts/parity` em comentário ou string de controle negativo, não
  importam nada de lá. `tests/media-evidence.test.ts` e
  `tests/workflow-service-durability.test.ts` (listados no #8) hoje importam
  de `scripts/mutations/**`, não de `scripts/parity` — já migrados pelas
  #149/#151.
- **`scripts/parity/scenarios/` (180 JSON) — parcial**:
  `tests/parity/scenarios.test.ts:11-52` nomeia 39 cenários (`it.each`) lidos
  com `readFileSync`/`resolve`; os outros ~141 não são lidos por nenhum teste
  hoje. A faixa 61-146 citada na issue é o corpo desses `it.each`, não uma
  varredura do diretório inteiro.
- **`manifests/t20/` (25 JSON) — sim**: `scenarios.test.ts:307-318` usa
  `readdirSync` e `it.each` sobre **todo** o diretório — cobertura
  exaustiva, não amostral.
- **`manifests/t15/` (1 JSON) — sim**: `scenarios.test.ts:133` (import
  direto do arquivo).
- **`manifests/t08,t09,t10,t13,t16/` (18+38+19+41+2 = 118 JSON) — não**:
  `grep -rln "manifests/t0[89]\|manifests/t1[036]" tests/` não retorna nada.
- `tests/parity/{bounds,harness,process,socket-sentinel}.test.ts` spawnam
  `python3` de verdade (`grep -n python3 tests/parity/*.ts`) — a cobertura
  "sim" desses arquivos de infra da raiz roda contra um oráculo real, não um
  stub; ainda depende do Python instalado no runner (#166).

### Tabela

`find scripts/parity -type f | awk -F/ '{ if (NF==3) print "RAIZ"; else print $3 }' | sort | uniq -c` reproduz a coluna Total por lane de uma vez.
23 subdiretórios de primeiro nível (`workflow-spec` incluído — o "23 lanes"
da issue já contava a raiz à parte; esta tabela soma raiz como linha própria,
24 no total).

| Lane                | Total   | A       | B       | C     | D      | Cobertura (arquivo:linha)                                                                                                                                                                                                                       |
| ------------------- | ------- | ------- | ------- | ----- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| scenarios           | 180     | 0       | 180     | 0     | 0      | parcial — 39/180 nomeados, `tests/parity/scenarios.test.ts:11-52,61-131`                                                                                                                                                                        |
| manifests           | 144     | 0       | 144     | 0     | 0      | parcial — 26/144 (`t15`: 1 em `scenarios.test.ts:133`; `t20`: 25 em `scenarios.test.ts:307-318`); `t08/t09/t10/t13/t16` (118): não                                                                                                              |
| openai-server       | 40      | 31      | 9       | 0     | 0      | não — nenhum arquivo aparece em `tests/`                                                                                                                                                                                                        |
| gateway             | 22      | 18      | 4       | 0     | 0      | sim (4/4 de B) — `tests/gateway/launch-candidate.test.ts:11-13`, `raw-socket-primitives.test.ts:12,17`, `launch-candidate-argv.test.ts:37`, `tests/t22-closeout.test.ts:13`; A: não                                                             |
| raiz                | 18      | 2       | 16      | 0     | 0      | sim (13/16 de B) — `tests/parity/{harness:5-6,guard:7-9,cli:7-9,scrub:7-8,preconditions:3-4,comparison:3-4,capture:8,manifest:3}.test.ts`; 3 fixtures e os 2 de A: não                                                                          |
| workflow-durability | 15      | 6       | 8       | 1     | 0      | não; C = `run-mutations.ts` (shim #149, `npm run mutations:t16`)                                                                                                                                                                                |
| cron                | 15      | 12      | 3       | 0     | 0      | não                                                                                                                                                                                                                                             |
| provider-transports | 13      | 8       | 5       | 0     | 0      | parcial — `responses-profile.ts` sim (`tests/parity/responses-profile.test.ts:4`); `pack-smoke.mjs` (A) pino de texto em `tests/t22-closeout.test.ts:137`; resto: não                                                                           |
| mcp                 | 13      | 6       | 7       | 0     | 0      | parcial — `harness.ts` (A) pino de texto em `tests/t22-closeout.test.ts:161`; `run-regression-gates-locked.sh` (B) pino em `:143`; resto: não                                                                                                   |
| closeout            | 13      | 0       | 0       | 1     | 12     | parcial — múltiplos pinos de texto em `tests/t22-closeout.test.ts:11-278` (ver `## Mutantes aposentados com #8`); `inventory.json`: não (`## Desvios declarados`); C = `run-closeout-mutations.ts` (shim #153, `npm run mutations:self-update`) |
| auth                | 6       | 5       | 1       | 0     | 0      | sim — `socket-sentinel.cjs` (B) e `python-sentinel/sitecustomize.py` (A) em `tests/parity/socket-sentinel.test.ts:31,53`; resto: não                                                                                                            |
| chat-completions    | 6       | 5       | 1       | 0     | 0      | não                                                                                                                                                                                                                                             |
| conversation        | 6       | 3       | 3       | 0     | 0      | não                                                                                                                                                                                                                                             |
| media               | 9       | 2       | 5       | 2     | 0      | não; C = `comparator.ts` (reexporta `scripts/mutations/media-comparator.js`) e `run-mutations.ts` (shim #151, `npm run mutations:t21`)                                                                                                          |
| tools               | 6       | 4       | 2       | 0     | 0      | não                                                                                                                                                                                                                                             |
| web-tools           | 7       | 6       | 0       | 1     | 0      | não; C = `run-mutations.ts` (shim #152, `npm run mutations:t20`)                                                                                                                                                                                |
| workflow-audit-live | 6       | 3       | 2       | 1     | 0      | parcial — `support.ts` (B) pino de texto em `tests/t22-closeout.test.ts:154`; resto: não; C = `run-mutations.ts` (shim #150, `npm run mutations:t17`)                                                                                           |
| workflow-executor   | 7       | 3       | 3       | 1     | 0      | sim (1/3 de B) — `candidate-chat.mjs` em `tests/parity/scenarios.test.ts:268-270`; C = `run-mutations.ts` (shim #149, `npm run mutations:t15`)                                                                                                  |
| workflow-spec       | 6       | 4       | 2       | 0     | 0      | não                                                                                                                                                                                                                                             |
| orchestration       | 5       | 4       | 1       | 0     | 0      | parcial — `run-gates.ts` (A) pino de texto em `tests/t22-closeout.test.ts:20`; resto: não                                                                                                                                                       |
| local-context       | 5       | 4       | 1       | 0     | 0      | não                                                                                                                                                                                                                                             |
| stub                | 4       | 2       | 2       | 0     | 0      | sim — `server.ts`/`types.ts` em `tests/parity/stub-lane-script.test.ts:8-10`, `stub-driver.test.ts:18`                                                                                                                                          |
| state               | 8       | 7       | 1       | 0     | 0      | não                                                                                                                                                                                                                                             |
| providers           | 2       | 2       | 0       | 0     | 0      | não                                                                                                                                                                                                                                             |
| **Total**           | **556** | **137** | **400** | **7** | **12** |                                                                                                                                                                                                                                                 |

### Outros números do levantamento do #8, corrigidos

- **48 scripts `parity:*`** → `grep -c '"parity:' package.json` = **47**.
- **`LOHRA_ORACLE_WORKSPACE` em 6 arquivos** → `grep -rl LOHRA_ORACLE_WORKSPACE
scripts/parity` = **5** (`closeout/run-closeout.ts`, `media/run-all.ts`,
  `orchestration/run-gates.ts`, `resolve.ts`, `state/probe-utils.mjs`).
- **CI: zero referências executáveis** — confirmado,
  `grep -rl "scripts/parity" .github` não retorna nada.

### Como este inventário se casa com os 27 mutantes aposentados

A tabela `## Mutantes aposentados com #8` acima cataloga **mutantes** (`id`),
não arquivos — não entram na soma de 556. Todos miram arquivos da classe D
(`scripts/parity/closeout/**`) desta seção, exceto os que miram `README.md`/
`package.json` (fora de `scripts/parity`, também fora da soma).
