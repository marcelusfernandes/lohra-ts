# EOL da fixture Git de archive — #826

Base `318dfb4d97118fe4704a41ed6d8c82abb59368d9`; vermelho compilável
`8648195358aa098608075957163fa083e024aaf6`; verde
`8e9dab5e3e3602f4c44e605bcad79e7f6eefda2d`. Logs brutos e clones de
ABI própria: `F:/lohra-m25-826/`. Os ensaios usaram homes, caches npm e TEMP
próprios em F:, sem mudar configuração Git global ou do checkout do produto.
Ambiente: Windows 11 Pro build 26200 x64, Node 20.20.2 e 22.23.2; Linux
Node 22.23.3, UID 1000, container `lohra-m25-linux-737-20261009`.

| Ensaio                                                   | Windows Node 20                                                                                                         | Windows Node 22                     | Linux Node 22                                                                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Focal base, SHA `318dfb4`                                | exit 1: archive `versao-1\r\n` contra LF literal; 33 skips                                                              | mesmo resultado                     | não repetido na base                                                                                            |
| Vermelho `8648195`, compilável                           | exit 1; blob v1 `76657273616f2d310a`, archive `76657273616f2d310d0a` contra esperado `76657273616f2d310a`               | mesmo resultado; typecheck 0        | não medido; o vermelho causal foi executado nas duas ABIs Windows                                               |
| Sonda isolada `probe.mjs`                                | `core.autocrlf` herdado `true` (local ausente): blobs v1/v2 LF, archive v1 CRLF; local `false`: blobs LF, archive v1 LF | mesmo resultado                     | não necessária para reproduzir Git for Windows                                                                  |
| `npm ci`                                                 | exit 0, clone ABI própria                                                                                               | exit 0, worktree ABI própria        | exit 0, clone `/work/lohra826`                                                                                  |
| build → typecheck → lint → format:check, verde `8e9dab5` | 0 → 0 → 0 → 0                                                                                                           | 0 → 0 → 0 → 0                       | 0 → 0 → 0 → 0                                                                                                   |
| `npm run prova -- windows-mutation-archive-eol`          | exit 0, 34/34                                                                                                           | exit 0, 34/34                       | exit 0, 34/34                                                                                                   |
| `npm test -- --maxWorkers=1`                             | não repetido; baseline Windows #751                                                                                     | não repetido; baseline Windows #751 | exit 0, 340 arquivos, 4.462 pass e 8 skips, 206,15 s                                                            |
| Controle negativo, base→verde                            | não repetido                                                                                                            | não repetido                        | exit 0, **SKIP mecânico**: diff só de teste/prova existente, overlay base≡head; vermelho nativo revisável acima |

O teste de archive preserva a asserção original de `"versao-1\n"` **exata**,
mesmo após o working tree e HEAD passarem para `versao-2`. As asserções novas
prendem os blobs v1/v2 e o archive extraído em hexadecimal. O verde adiciona
apenas `git config --local core.autocrlf false` ao repo temporário desse caso,
antes de `git add` e commit v1. A sonda
[probe.mjs](probe.mjs) conserva repositórios próprios para inspeção; suas
projeções sem caminhos pessoais estão em [Node 20](probe-node20.json) e
[Node 22](probe-node22.json). No modo herdado, o valor efetivo vem de
`C:/Program Files/Git/etc/gitconfig`, não da configuração local do repo fake;
no modo fixado, a configuração local prevalece.

O teste `snapshotFiles / restoreAll` de CRLF, “– café” e ausência de newline
final permanece byte a byte (`Buffer.compare`), sem `trim`, skip ou
normalização. Ele passou nas provas 34/34 das três plataformas. O archive de
um blob propositalmente CRLF com `-text` também permaneceu CRLF na sonda
anterior `F:/lohra-eol-810/results.jsonl`, contraexemplo à normalização
genérica. O harness de produção não foi alterado.

Reprodução no checkout após `npm ci`:

```text
npm run build
npm run typecheck
npm run lint
npm run format:check
npm run prova -- windows-mutation-archive-eol
npm test -- --maxWorkers=1
npm run ci:controle-negativo -- --base 318dfb4d97118fe4704a41ed6d8c82abb59368d9 --head 8e9dab5e3e3602f4c44e605bcad79e7f6eefda2d --branch test/826-windows-mutation-archive-eol
node docs/investigations/windows/evidence/mutation-archive-eol/probe.mjs <OWN_OUTPUT_DIR>
```

A suíte completa e o controle negativo foram executados no clone Linux; logs
em `F:/lohra-m25-826/linux-logs/`. Dogfooding de provider é N/A porque a
branch toca apenas teste, prova e esta evidência. CI/revisão independente não
são inferidos dos gates locais.
