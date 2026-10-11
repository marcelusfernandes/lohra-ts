# #821 — doutrina inválida antes da aquisição de estado

Base `6cf57f3dbe9a67ce790e5aa3b82d7db44ea8a380`, vermelho compilável
`835bf0bb2cd50bc05bb7089212b7dff267ee16ac`, código candidato
`0afe2e7f8b80f9db3d201118019234acace958e6`. O teste novo chama `runChat`
com um provider de prova local sem credencial e `LOHRA_DOCTRINE=loud`, aponta
`HOME`, `LOHRA_HOME` e `options.home` para uma raiz temporária própria e exige
o erro original e ausência de `state.db`. Nenhum request ao provider é
necessário: a configuração falha antes do turno.

No vermelho, Node 22.23.2 no worktree e Node 20.20.2 em clone independente
retornaram `EBUSY unlink state.db` ao limpar o temporário após a rejeição
`LOHRA_DOCTRINE`; o banco tinha sido adquirido antes da validação. No Linux
Node 22.23.3, a limpeza POSIX não ficou bloqueada, mas a assertion de ausência
de `state.db` falhou (`expected true to be false`). Os logs brutos de cada
ambiente foram preservados em `F:/lohra-821/native-logs/` e
`F:/lohra-821/linux-logs/`; não se atribui o EBUSY a todas as falhas do
inventário #751.

O código candidato resolve `resolveDoctrineTier` e `doctrineText` uma vez
depois dos gates de provider/modelo/fan-out e antes de
`openStateForEnvironment`. O mesmo valor passa ao snapshot de prompt da
sessão. A fixture existente de `chat-doctrine-tier.test.ts` declara
`LOHRA_HOME` igual ao `home` explícito nos casos válidos e inválido, sem
alterar markers, asserts, retry ou skip. Em clones independentes com ABI
própria, Node 20.20.2 e 22.23.2 no Windows passaram o focal 4/4, os quatro
gates (`build`, `typecheck`, `lint`, `format:check`) e a prova 4/4, todos com
exit 0 no SHA `0afe2e7`. O vermelho foi exit 1 nas duas ABIs, como acima.
Os ambientes de execução isolaram `HOME`, `USERPROFILE`, `LOHRA_HOME`,
`CODEX_HOME`, `TEMP`, `TMP` e cache/prefix npm fora do checkout.

No Linux, Node 22.23.3 como usuário `node` não privilegiado passou os cinco
gates: 339 arquivos, 4425 testes aprovados e 4 ignorados na suíte completa
(187,19 s); prova 4/4 e controle negativo com `assertion-red`, todos exit 0.
A fatia `mutations:t23` matou 46/46 mutantes, `restoreGreen=true`. Essa fatia
inclui mutantes de doutrina no contexto, mas não um mutante específico do
preflight em `src/commands/chat.ts`; o vermelho focal prende diretamente essa
ordem. Logs completos estão em `F:/lohra-821/linux-logs/` e os dados de
mutação em `/work/lohra821/.mutation-evidence/t23/mutations.json` no clone
Linux. Nenhuma suíte Windows completa é alegada.

O dogfooding com provider real autorizado, via CLI compilada do worktree
`0afe2e7`, terminou com exit 0, JSON `error:null`, uma chamada `read_file`
de `src/commands/chat.ts` e marcador esperado na resposta. Resultado
sanitizado: `F:/lohra-821/dogfood-result.json`. Isso verifica a rota real
de chat, separada do vermelho com stub sem credenciais. As falhas de limpeza
`EBUSY` deixaram um temporário próprio por ABI no ensaio vermelho; a revisão
automática bloqueou a exclusão recursiva posterior. Manifesto sanitizado:
`F:/lohra-821/red-residues.json`.
