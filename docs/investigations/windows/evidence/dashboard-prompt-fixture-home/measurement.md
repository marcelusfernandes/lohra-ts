# #853 — home da fixture de prompt do dashboard

## Árvores e ambientes

- Base: `c1dc5596a5fff72219cbfe6d28caec1b5942f275`.
- Vermelho compilável: `b9c6b7287291e7f1c38f4f05b29ceb744e499f58`.
- Candidato de teste: `6c900c0026975eeb3ee27596fd659df626d04949`.
- Windows: clones descartáveis separados em `F:/lohra-m25-853/clone20`
  (Node 20.20.2) e `clone22` (Node 22.23.2), com `npm ci` por ABI. HOME,
  USERPROFILE, LOHRA_HOME, CODEX_HOME, TEMP/TMP, cache/prefixo npm próprios em
  F:. Provider apenas HTTP loopback criado pelo teste.

A primeira instalação do clone Node 20 foi **inválida para medir o produto**:
o npm foi iniciado pelo executável 20, mas o PATH deixou o ciclo nativo usar
Node 22, gerando `better-sqlite3` ABI 127 em vez de 115. Ela está preservada
em `npm-ci-20.log`/`baseline-20.log`, mas excluída da contagem abaixo.
Reinstalei com o diretório Node 20 no início do PATH; `require('better-sqlite3')`
confirmou Node 20.20.2/ABI 115, e `npm-ci-20-correct.log` registrou exit 0.

## Vermelho real e hipótese

Com dependências corretas, o teste original passou 1/2 e falhou no caso
`DOCTRINE_EXTENDED` em ambas as ABIs: timeout original de 5 s e `EBUSY`
secundário ao remover `<root>/lohra/state.db`. O runner também registrou
rejeição não tratada `ENOENT` em `realpathSync(<root>/.lohra)`, chamada de
`createOutputPlan` em `src/media/persistence.ts:76` pelo boot de
`runDashboard`. Logs completos: `baseline-20-correct.log` e
`baseline-22.log`. O inventário #751 nomeou a falha primária como
`STACK_TRACE_ERROR`; o replay focal não reproduziu esse rótulo, mas expôs
o `ENOENT` causal antes do boot e o `EBUSY` de limpeza. Não atribuí o
`EBUSY` isoladamente à divergência de home.

As duas chamadas passavam `environment.HOME=root`, sem `LOHRA_HOME`, embora
`options.home=<root>/.lohra`. No Windows,
`resolvePaths(options.environment).home` escolhia `<root>/lohra`, deixando
estado em outra raiz. O segundo caso não criava `<root>/.lohra` antes do
consumidor de mídia. O commit vermelho adicionou a checagem comportamental
de `resolvePaths(...).home === home` antes do boot: typecheck exit 0;
Node 20/22 falharam 2/2 com recebido `<root>/lohra` e esperado
`<root>/.lohra`. Logs `red-contract-{20,22}.log`.

Dois controles em clones próprios isolaram a suficiência de cada ajuste:

| Variante temporária                                      | Node 20 | Node 22 | Leitura                                                |
| -------------------------------------------------------- | ------: | ------: | ------------------------------------------------------ |
| Criar somente `.lohra` no segundo caso, sem `LOHRA_HOME` |     2/2 |     2/2 | Ausência do diretório bastava para o timeout focal.    |
| Definir somente `LOHRA_HOME=home` nas duas chamadas      |     2/2 |     2/2 | O estado passou a preparar a mesma raiz do consumidor. |

Fontes originais foram restauradas por hash após os controles. Logs
`home-only-{20,22}.log` e `lohra-only-{20,22}.log`. A hipótese de que a
divergência **sozinha** causava o timeout foi refutada pelo primeiro
controle; alinhá-la continua parte do contrato da fixture e evita estado
gravado em outro home.

## Candidato

O segundo caso cria explicitamente `.lohra` antes do boot. As duas chamadas
passam `LOHRA_HOME: home` sem alterar `process.env`; a checagem do caminho
resolvido fica nos dois casos. `it`/`describe`, marcadores SOUL, memória,
contexto, doutrina extended, provider loopback, WS/SSE, asserts existentes e
timeouts permanecem. O focal terminou 2/2 em Node 20/22, sem erros não
tratados e com zero roots residuais nas áreas TEMP novas; logs
`green-focal-{20,22}.log`.

## Gates

| Ambiente                           | `npm ci` | build | typecheck | lint | format:check |  prova |
| ---------------------------------- | -------: | ----: | --------: | ---: | -----------: | -----: |
| Windows Node 20.20.2               |        0 |     0 |         0 |    0 |            0 | 0, 2/2 |
| Windows Node 22.23.2               |        0 |     0 |         0 |    0 |            0 | 0, 2/2 |
| Linux Node 22.23.3, usuário `node` |        0 |     0 |         0 |    0 |            0 | 0, 2/2 |

Os quatro gates nativos e `npm run prova --
windows-dashboard-prompt-fixture-home` rodaram nos clones próprios, com logs
`F:/lohra-m25-853/native-{20,22}-*.log`; a prova retornou
`{"ok":true,"total":2,"falhas":[]}` em ambas. Linux usou bundle do SHA
`6c900c0` em clone separado `/work/lohra853`, no container
`lohra-m25-linux-737-20261009` como usuário `node`, com HOME, LOHRA_HOME,
CODEX_HOME, TMPDIR e cache próprios. `npm test -- --maxWorkers=1` terminou
exit 0: **340 arquivos, 4494 aprovados e 8 ignorados** em 204,45 s; estes
totais pertencem a esta base/SHA e não são comparados como catálogo idêntico
ao de outra issue. `npm run prova -- windows-dashboard-prompt-fixture-home`
terminou exit 0, 2/2. O controle negativo mecânico com base `c1dc559`, head
`6c900c0` e branch exata terminou exit 0 com **SKIP test-only** (base+overlay
equivale ao head). O vermelho real em Node 20/22 e os controles de home são
a evidência comportamental. Logs Linux completos em
`F:/lohra-m25-853/linux-evidence/`, com `results.tsv` para os sete exits.
CI e revisão independente seguem pendentes até a PR.
Dogfooding real: N/A — apenas testes, declaração de prova e evidência.
