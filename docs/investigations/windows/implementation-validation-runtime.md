# #757 — cancelamento e retomada de tarefa real no Windows

**Estado após as medições de 2026-10-11/12: PARTIAL.** O Ctrl+C público agora
interrompe a operação local em menos de 2 s, preserva o arquivo concluído e
devolve um envelope explícito de cancelamento. [#920](https://github.com/marcelusfernandes/lohra-ts/issues/920)
foi integrada pela [PR #922](https://github.com/marcelusfernandes/lohra-ts/pull/922).
A retomada lê o arquivo sem repetir a operação, mas ainda não identifica de
forma confiável a tarefa interrompida. O aceite desta issue depende de uma
solução e medição positivas para [#923](https://github.com/marcelusfernandes/lohra-ts/issues/923).

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

## Primeira medição, antes de #920

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
Naquela versão, o turno não produziu envelope nem aviso persistido. A falha de
produto foi corrigida em #920; as repetições abaixo medem o comportamento novo.

## Repetições focais com o pacote instalado

O candidato `a8c44ceed3edc0a65d9f839d16ac7686075605af` de #920, depois
integrado no merge `2c5e7c49f019219778d82d21a43e363d3b2ac603`, foi
exercitado com provider real, Node 22 e o CLI instalado. O controlador enviou
o byte de Ctrl+C pelo ConPTY público depois de `write_file` e do início do
`terminal` local. O JSON saiu com `completed=false`,
`error="conversation cancelled"` e a mesma sessão, em 1.430 ms; o processo
próprio estava encerrado, não houve conclusão natural de 30 s e
`entrega-final.txt` permaneceu íntegro. O aviso `cancelled` dessa execução foi
persistido e recebeu ack na retomada. Ainda assim, o modelo explicou uma
falha antiga `MODULE_NOT_FOUND` ao responder sobre a execução mais recente.

Duas variações focais de #923 repetiram apenas cancelamento e retomada:

| Candidato                                | Ctrl+C → saída | Operação e arquivo                                 | Resposta na retomada                                          |
| ---------------------------------------- | -------------: | -------------------------------------------------- | ------------------------------------------------------------- |
| `a8c44ce` (#920, depois integrado)       |       1.430 ms | Child encerrado; `entrega-final.txt` preservado    | Leu o arquivo, mas atribuiu a execução recente ao erro antigo |
| `87221df` (#923 local, aviso contextual) |       1.426 ms | Child encerrado; `entrega-contexto.txt` preservado | Leu o arquivo, mas tratou o aviso como suspeito               |
| `ec5a2b3` (#923 local, aviso factual)    |       1.922 ms | Child encerrado; `entrega-factual.txt` preservado  | Leu o arquivo, mas tratou o aviso como suspeito               |

Em todas as retomadas houve exit 0, `completed=true`, `error=null` e somente
`read_file`; não houve replay de `terminal`. As [projeções das três
medições](evidence/implementation-validation/runtime/followup-observations.json)
preservam os fatos necessários sem prompts, IDs de sessão ou transcrições
integrais. Os candidatos de #923 são locais; nenhum dos dois constitui
aceite. O aviso contextual/factual foi concatenado ao conteúdo de um turno
com papel `user` no runtime, sem origem autenticável distinta para o modelo.
As respostas suspeitando de um “aviso de operador” são compatíveis com esse
limite, mas os três ensaios não demonstram qual apresentação futura será
suficiente. A escolha do comportamento público de aviso segue em #923.

## Aceite e próximos passos

Os critérios de ambiente, tarefa real, Ctrl+C com erro explícito dentro de
10 s, encerramento do child próprio, preservação de artefato e retomada
operacional têm evidência positiva. O aviso persistido e reconhecido demonstra
o caminho técnico de notificação, mas a resposta ao usuário continua errada ou
incerta. O critério de estado compreensível permanece **FAIL** e bloqueia o
aceite integral de #757. A próxima medição depende da decisão de produto e da
correção de #923; não há necessidade de repetir as partes já comprovadas.

Esta rodada não aceita cron, compactação, gateway amplo, crash/lease ou
proteção entre identidades. Esses limites continuam em [#736](https://github.com/marcelusfernandes/lohra-ts/issues/736)
e [#758](https://github.com/marcelusfernandes/lohra-ts/issues/758). Tampouco
declara suporte global a Windows ou a todos os provedores.
