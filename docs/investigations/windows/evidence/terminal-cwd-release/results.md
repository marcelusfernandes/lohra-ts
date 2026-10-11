# Terminal público e liberação do cwd — #859

Base `96756a53e03a87ddb3edfa2a419f756c493a1f3f` (bridge #858 já integrada),
vermelho `3d242fc`, código verde `1372d4e67cec7866f38764a1c79ece99a090a17e`.
Os logs brutos permanecem em `F:/lohra-859/`; não contêm credenciais. Windows
11 Pro build 26200, x64; Node 20.20.2 e 22.23.2. As duas instalações usaram
`node_modules`, `LOHRA_HOME`, `CODEX_HOME`, `HOME`, `USERPROFILE`, cache npm,
`TEMP` e `TMP` próprios em F:. O clone Node 20 foi criado sem `core.protectNTFS=false`.

| Ensaio                                          | Node 20 Windows                                                                                                     | Node 22 Windows               | Linux Node 22.23.3                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| Vermelho do terminal público                    | Envelope `{ok:true,stdout:"LOHRA859_OK\\r\\n",stderr:"",exit_code:0}`; `rmSync(caller)` falha `EBUSY`, focal exit 1 | Mesmo resultado, focal exit 1 | Teste de cwd nativo pulado; negativo portátil abaixo                                        |
| `npm ci`                                        | exit 0, clone ABI próprio                                                                                           | exit 0, worktree ABI próprio  | exit 0, clone `/work/lohra859`                                                              |
| build → typecheck → lint → format:check         | 0 → 0 → 0 → 0                                                                                                       | 0 → 0 → 0 → 0                 | 0 → 0 → 0 → 0                                                                               |
| `npm run prova -- windows-terminal-cwd-release` | exit 0, 57/57                                                                                                       | exit 0, 57/57                 | exit 0, 49/49; 8 casos Windows pulados                                                      |
| `npm test -- --maxWorkers=1`                    | não repetido; inventário Windows #751 registra baseline externo                                                     | não repetido; inventário #751 | exit 0, 340 arquivos, 4.456 aprovados e 8 skips, 208,23 s                                   |
| Controle negativo base→verde, sem `--slug`      | não repetido                                                                                                        | não repetido                  | exit 0, `assertion-red — PASS`: ferramenta pública ainda chamava PTY direta na base         |
| `npm run mutations:self-update`                 | não repetido                                                                                                        | não repetido                  | exit 0, 12/12 mortos, 0 sobreviventes, `restoreGreen:true`, incluindo `T22-node-pty-bypass` |

O teste nativo cria um processo próprio cujo `process.cwd()` é um diretório
temporário; executa `terminalTool` com `cwd` explícito, restaura o cwd e tenta
remover o diretório **imediatamente após o retorno**. No vermelho, a saída do
comando já era correta, mas a remoção falhava. No verde, o processo terminou
naturalmente, `released:true`, sem retry, GC ou busca de PIDs alheios. Os testes
existentes preservam stdout/stderr/status 7, Unicode, limites de saída, falha
de shell, EOF/crash/timeout e árvore própria. Um teste portátil simula Windows
e comprova que a recusa perigosa antecede a chamada à bridge; no Linux, ele
é a asserção vermelha real do controle negativo.

Dogfooding real no código verde `1372d4e`, via CLI `dist/cli.js chat --json
--no-input --max-iterations 3 --max-parallel 1` e provider configurado pelo
orquestrador: exit 0, `error:null`, exatamente uma chamada `terminal`, resultado
parseado `ok:true`, `exit_code:0`, stdout exato `LOHRA859_TOOL_OK\r\n`, stderr
vazio. A CLI encerrou naturalmente e o cwd temporário próprio foi removido
imediatamente. A projeção sem segredos está em [dogfood-result.json](dogfood-result.json);
o procedimento parametrizado está em [dogfood.mjs](dogfood.mjs). Essa medição
não foi um provider stub. O script real da rodada e os logs de build ficaram
em `F:/lohra-859/dogfood-orchestrator.mjs` e `dogfood-build.log`.

Reprodução local dos gates no checkout candidato após `npm ci`:

```text
npm run build
npm run typecheck
npm run lint
npm run format:check
npm run prova -- windows-terminal-cwd-release
npm test -- --maxWorkers=1
npm run ci:controle-negativo -- --base 96756a53e03a87ddb3edfa2a419f756c493a1f3f --head 1372d4e67cec7866f38764a1c79ece99a090a17e --branch fix/859-windows-terminal-cwd-release
npm run mutations:self-update
```

`npm test` e os dois últimos comandos foram medidos no clone Linux. Os logs
correspondentes estão em `F:/lohra-859/linux-logs/`. Nenhuma execução de CI
ou revisão independente é presumida por estas medições locais.
