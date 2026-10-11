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

O mesmo teste usa links simbólicos para `process.execPath`, evitando copiar
três executáveis grandes sob o limite de cinco segundos do Vitest. A execução
focal final de `tests/process-shell.test.ts` e
`tests/protege-main.test.ts` passou **31/31** em cada ABI Windows. Os logs
locais são `F:/lohra-m25-812/node{20,22}/ci-precedence-symlink-red.log`,
`ci-precedence-symlink-green.log` e `ci-round2-focused-final.log`.

O ambiente do filho continua sendo uma cópia: o `PATH` global não é alterado.
Em POSIX, `Path` é uma variável distinta e não é tratada como `PATH`; no
Windows, as variantes de caixa continuam normalizadas pela regra do helper.
Os gates completos e a prova do SHA da segunda rodada são relatados na PR.
