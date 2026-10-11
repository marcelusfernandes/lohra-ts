# Diagnóstico inicial da #864

O CI `38128169582` no HEAD `dabe6862335a58f6a17e7130641844b6280633f9`
falhou em `tests/protege-escrita.test.ts` nas duas ABIs. Node 20 e 22
executaram os dez casos: sete recusas esperadas com status 2 retornaram 0;
as três permissões continuaram 0. `tests/process-shell.test.ts` passou 7/7
nos mesmos jobs. Os logs do CI não registraram stdout/stderr da chamada do
hook, logo não identificam sozinhos qual condição fez o hook aceitar.

Na fixture dummy local em F:, Node 20.20.2 e 22.23.2 com Git
2.47.1.windows.1 e `C:\Program Files\Git\bin\sh.exe` preservaram `Write`,
`file_path` e `cwd` no roundtrip stdin → shell → `PE_PAYLOAD` → Node. O Git
retornou o toplevel da fixture, e os caminhos reais produziram
`docs/reference`; o hook respondeu status 2 com motivo `docs/reference/`.
Os arquivos `F:/lohra-m25-864/diagnose-node{20,22}.json` guardam somente
metadados e paths dummy dessa medição. **Esse verde local não explica o CI.**

Um controle adicional com `Git/usr/bin/sh.exe` e PATH mínimo sem `cat`
reproduziu status 0 e stderr `cat: command not found`: o hook lê payload
via `cat`, e JSON vazio é aceito no `catch`. Ao incluir `Git/usr/bin` no
PATH, o mesmo controle recusou com status 2. Isso demonstra uma condição
independente de fail-open; ainda **não** há evidência de que `cat` estivesse
ausente no runner, cujo teste `process-shell` passou. Nenhuma política foi
alterada nesta etapa.

O próximo sinal discriminante usa dois scripts temporários: um mede o
roundtrip JSON sob `spawnProcessShell`; o outro usa o mesmo transporte para
medir `git rev-parse`, a existência de `.claude/settings.json` e a rota
canônica `docs/reference/novo.md`. As falhas de recusa também exibem
stdout/stderr/status/shell da chamada real. Não captura ambiente completo
nem payload sensível; os inputs são caminhos dummy em diretórios próprios.
As flags `MSYS_NO_PATHCONV`, `MSYS2_ARG_CONV_EXCL` e
`MSYS2_ENV_CONV_EXCL` são relatadas apenas como ausentes, `*` ou outro valor
presente; as três estavam ausentes no processo local da medição. O shell
resolvido aparece por caminho para distinguir Git Bash de outro pacote.

No candidato diagnóstico, `npm run typecheck` e o foco
`tests/protege-escrita.test.ts` + `tests/process-shell.test.ts` saíram 0 em
Node 20/22 locais (19/19 testes). Este resultado é local; não reclassifica
as sete falhas observadas nos dois jobs do CI.

## Draft #869: assinatura nas duas ABIs do runner

No HEAD `f7495148`, os jobs Windows Node 20 (`114444442869`) e Node 22
(`114444443143`) repetiram as sete recusas com status 0, stdout e stderr
vazios. O shell resolvido foi `C:\Program Files\Git\bin\sh.exe`; as três
flags de conversão MSYS observadas estavam ausentes. O teste de transporte
stdin → `PE_PAYLOAD` passou. A sonda de raiz recebeu `Write`, Git saiu 0 e
`.claude/settings.json` existia, mas o relativo retornou
`../../../../../RUNNER~1/AppData/Local/Temp/protege-escrita-…/docs/reference/novo.md`
em vez de `docs/reference/novo.md`. Logs integrais sanitizados fora do repo:
`F:/lohra-m25-864/ci-draft-node20.log` e
`F:/lohra-m25-864/ci-draft-node22.log`.

O resultado prova que grafias distintas do ancestral da fixture (alias
Windows 8.3 versus caminho usado pelo Git) rompem a comparação lexical do
hook. Ainda falta medir se `fs.realpathSync.native` unifica ambas nesse runner.
Uma sonda adicional registra somente os relativos convencional e `native`,
sem divulgar o ambiente completo nem alterar a política. O host local não
apresentou o alias `RUNNER~1`; o CI continua sendo a bancada discriminante.

## Draft #869: comparação nativa confirmada

No HEAD `f73e3aa`, os jobs Windows Node 20 (`114447209136`) e Node 22
(`114447209355`) mediram, no mesmo processo e fixture, relativo convencional
`../../../../../RUNNER~1/AppData/Local/Temp/protege-escrita-…/docs/reference/novo.md`
e `nativeRelative: docs/reference/novo.md`. `gitStatus` permaneceu 0 e
`settings` verdadeiro. Os logs estão em
`F:/lohra-m25-864/ci-native-check-node20.log` e
`F:/lohra-m25-864/ci-native-check-node22.log`. Esses resultados dão uma
explicação causal para as sete permissões indevidas: o hook compara strings
de caminhos equivalentes com grafias diferentes e nenhuma delas casa com
`docs/reference/` sob a raiz textual. A troca para `fs.realpathSync.native`
no helper de canonicalização do hook usa identidade de caminho fornecida pelo
filesystem, sem substituir `~1` manualmente nem mudar a política. O CI após
essa correção ainda precisa confirmar as sete recusas e três permissões.

## TDD e confirmação focal no CI

O commit de correção `882df38` usou `fs.realpathSync.native` no helper do hook.
No run `38132586141`, `tests/protege-escrita.test.ts` passou 11/11 e
`tests/process-shell.test.ts` passou 8/8 tanto em Node 20 (`114450120147`)
quanto em Node 22 (`114450120108`). A job Windows completa continuou
vermelha por outros testes, portanto esse resultado é **focal**, não aceite
global da plataforma. Logs: `F:/lohra-m25-864/ci-fix-node20.log` e
`F:/lohra-m25-864/ci-fix-node22.log`.

O commit `test(red):` `40273a7` restaurou temporariamente o realpath
convencional e fortaleceu os sete testes de recusa para verificar também
envelope JSON, decisão `deny` e motivo em stderr. No run `38133066290`,
Node 20 (`114451223462`) e Node 22 (`114451223466`) voltaram a ter
exatamente sete falhas entre os onze casos do hook: cada recusa esperava
status 2 e recebeu 0 com stdout/stderr vazios; as três permissões e a
sonda passaram. O helper de shell passou 8/8. Logs:
`F:/lohra-m25-864/ci-red-checkpoint-node20.log` e
`F:/lohra-m25-864/ci-red-checkpoint-node22.log`. A restauração de `.native`
no commit verde seguinte fecha o ciclo sem reescrever os SHAs anteriores.
