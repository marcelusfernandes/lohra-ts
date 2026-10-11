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

O próximo sinal discriminante é um teste de script que mede o roundtrip
JSON sob `spawnProcessShell`, mais stdout/stderr/status/shell da chamada
real quando uma recusa falhar. Não captura ambiente completo nem payload
sensível; os inputs são caminhos dummy em diretórios temporários próprios.

No primeiro candidato diagnóstico, `npm run typecheck` e o foco
`tests/protege-escrita.test.ts` + `tests/process-shell.test.ts` saíram 0 em
Node 20/22 locais (18/18 testes). Este resultado é local; não reclassifica
as sete falhas observadas nos dois jobs do CI.
