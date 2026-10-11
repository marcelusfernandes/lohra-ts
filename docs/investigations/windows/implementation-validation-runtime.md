# #757 — cancelamento e retomada de tarefa real no Windows

**Estado em 2026-10-11: PARTIAL.** O cancelamento público por Ctrl+C parou a
operação local e preservou o arquivo concluído, mas a CLI saiu com código 1 sem
envelope de cancelamento. A retomada funcionou, porém não recebeu aviso da
interrupção. O aceite desta issue depende da correção focal [#920](https://github.com/marcelusfernandes/lohra-ts/issues/920)
e da repetição apenas do passo afetado com o pacote corrigido.

## Ambiente e recorte

- Windows x64 nativo; Node `22.23.2`; `lohra-ts 0.0.13` instalado fora do
  checkout, com `LOHRA_HOME` isolado. Base `4ccde71f85aba5f2e986717ec779104a6ac7575f`,
  candidato `247d6c246956ac3c52e9e91f0781ee3a69842fc0`, integrado no merge
  `7f99afd3499bd9cced0033c505625c5a85d80acd` ([PR #914](https://github.com/marcelusfernandes/lohra-ts/pull/914)).
- Provider real Codex, modelo `gpt-6-sol`; `doctor --json` do pacote corrigido
  informou `usable=true` e exit 0. A projeção preserva somente esses campos,
  sem caminho de autenticação, credencial ou banco.
- Uma tarefa com dados fictícios leu `vendas.csv`, escreveu `relatorio.md` e
  `resumo.csv` e verificou os números com uma chamada `terminal`. O total foi
  R$ 124,50, 15 unidades; os arquivos foram conferidos. Uma retomada na mesma
  sessão recuperou o contexto e leu `resumo.csv`; outro home não conhecia o
  código de continuidade. Esses resultados vêm da rodada [#913](https://github.com/marcelusfernandes/lohra-ts/issues/913),
  aproveitada aqui sem repetir a bateria.
- A medição específica de #757 gravou `checkpoint.txt`, iniciou uma operação
  local fictícia limitada a 30 s e enviou Ctrl+C pelo PTY público após o
  início. Não se usou VM, Docker, stub de provider, morte por nome de processo
  nem sondas de crash.

As [projeções sanitizadas](evidence/implementation-validation/runtime/procedure.md)
registram comandos, observações e limites. Transcrições integrais, `auth.json`,
`.env` e `state.db` não integram esta documentação.

## Resultado observado

| Verificação                             | Observado                                                                                          | Situação                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------ |
| Pacote instalado e tarefa real limitada | Node 22, home isolado, ferramentas `read_file`, `write_file`, `terminal`; R$ 124,50 e 15 unidades  | PASS                           |
| Checkpoint antes da interrupção         | `checkpoint.txt` preservado; SHA-256 registrado na projeção                                        | PASS                           |
| Ctrl+C público no PTY                   | Primeiro controle em 6,941 s: child PID 75060 encerrado; sem marcador de conclusão natural; exit 1 | PARTIAL                        |
| Confirmação de cancelamento             | `cancelEnvelope=null`; não houve aviso persistido para a retomada                                  | FAIL; #920                     |
| Retomada da mesma sessão                | Exit 0, `completed=true`, `error=null`, uma chamada `read_file`, sem repetição de `terminal`       | PASS, com ressalva de contexto |
| Estado compreensível na retomada        | Resposta mencionou falha de preparação anterior, não o cancelamento medido                         | FAIL; #920                     |

O primeiro ensaio de cancelamento apontou para uma fixture em outra pasta.
O prompt congelado manteve o diretório da sessão original e o comando retornou
`MODULE_NOT_FOUND`. Isso foi **erro de preparação do operador**: a fixture foi
colocada no diretório correto antes da medição acima. Esse erro não entra como
defeito de cancelamento. A consulta somente leitura ao banco isolado encontrou
zero mensagens do turno interrompido e uma mensagem da retomada; ela não
demonstrou corrupção do histórico previamente concluído.

O processo local estava encerrado no primeiro controle, dentro do limite de
10 s, e o arquivo concluído permaneceu íntegro. A evidência não demonstra
cancelamento de chamadas remotas já enviadas nem reembolso do provider. Também
não generaliza a observação de um child para todos os recursos do runtime.
Como o turno não produziu envelope nem aviso persistido, não é possível marcar
a jornada completa como aprovada.

## Aceite e próximos passos

Os critérios de ambiente, tarefa real, preservação de artefato e retomada
operacional têm evidência positiva. Ficam pendentes confirmação explícita de
cancelamento, estado correto no turno seguinte e verificação de que nenhuma
nova chamada de ferramenta começa após o cancelamento observado. [#920](https://github.com/marcelusfernandes/lohra-ts/issues/920)
liga o sinal público ao `AbortSignal` e ao mecanismo de aviso já existente;
somente uma repetição da sequência `write_file` → operação limitada → Ctrl+C →
retomada com o pacote corrigido pode preencher esses critérios. O relatório
será atualizado com o SHA, saída, prazo e estado reais dessa repetição antes
de propor o fechamento de #757.

Esta rodada não aceita cron, compactação, gateway amplo, crash/lease ou
proteção entre identidades. Esses limites continuam em [#736](https://github.com/marcelusfernandes/lohra-ts/issues/736)
e [#758](https://github.com/marcelusfernandes/lohra-ts/issues/758). Tampouco
declara suporte global a Windows ou a todos os provedores.
