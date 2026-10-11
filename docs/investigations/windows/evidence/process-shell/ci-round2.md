# #812 — falha de precedência do PATH na primeira CI

O primeiro run da PR #832 em Linux falhou nos jobs Node 20 e 22. Em ambos, as
assertions de `tests/protege-main.test.ts:323,337` viram `existsSync(marker)`
retornar `false`; os demais casos da suíte passaram. Logs preservados em
`F:/lohra-m25-812/ci-round1-node20.log` e `ci-round1-node22.log`.

O helper anterior colocava `path.dirname(shellPath)` **antes** do `PATH` do
chamador para que um processo aninhado encontrasse `sh`. No runner, isso
também colocava o diretório que contém `gh` real antes do shim da fixture. O
controle adiciona dois executáveis `gh` temporários e locais, um no diretório
prioritário do chamador e outro junto ao shell. Nenhum executável real `gh` é
invocado. Com o código da primeira CI, Node 20 e 22 escolheram o concorrente
junto ao shell (`red_exit=1`). Com o diretório do shell **após** o `PATH`
original, ambos escolheram o shim prioritário (`green_exit=0`).

O teste faz uma cópia de `process.execPath` antes dos casos e usa hardlinks
temporários no mesmo volume, evitando copiar três executáveis grandes dentro
do limite de cinco segundos do Vitest. A execução
focal final de `tests/process-shell.test.ts` e
`tests/protege-main.test.ts` passou **31/31** em cada ABI Windows. Os logs
locais são `F:/lohra-m25-812/node{20,22}/ci-precedence-hardlink-red.log`,
`ci-precedence-hardlink-green.log` e `ci-round2-prova-hardlink.log`.

O primeiro full Linux do candidato (`f5bfe130`) falhou nesse novo teste:
`process.execPath` de um hardlink para Node foi normalizado para
`/usr/local/bin/node`, de modo que o nome do link não identificava qual
`gh` foi lançado. O controle POSIX final usa dois pequenos scripts locais
que imprimem `preferred` e `competing`; a versão anterior do helper escolhe
`competing` (red), e a corrigida escolhe `preferred` (green, 7/7 focais).
Os logs do full intermediário e do controle red/green POSIX estão em
`F:/lohra-m25-812/linux-evidence/round2-intermediate/`; a falha do full não é
classificada como gate verde.

Uma prova sob carga simultânea de Node 20/22 expôs timeout no segundo caso
`protege-main` em Windows. A fixture copiava um executável Node grande dentro
do tempo de cinco segundos do teste, uma hipótese de causa apoiada pelo
experimento, sem medição isolada do custo da cópia. O stub temporário `gh.exe`
agora usa hardlink para uma cópia preparada em `beforeAll`, fora do relógio
individual dos testes, mantendo o preload que grava o marcador e impede
acesso ao `gh` real. A cópia e os links são criados sob o mesmo `tmpdir()`;
`afterAll` remove a cópia. Na repetição concorrente, a prova ficou em
**70/71** por ABI, com apenas o bit executável de `secao.sh` em NTFS (#823)
ainda vermelho. Logs:
`F:/lohra-m25-812/node{20,22}/ci-round2-prova-symlink.log`.

O ambiente do filho continua sendo uma cópia: o `PATH` global não é alterado.
Em POSIX, `Path` é uma variável distinta e não é tratada como `PATH`; no
Windows, as variantes de caixa continuam normalizadas pela regra do helper.
Os gates completos e a prova do SHA da segunda rodada são relatados na PR.
