# Notas de decisão

O que fica registrado aqui: doutrina, comportamento observado e decisão de
escopo que valem a pena escrever — mas que não mudam arquitetura nem contrato
público. Uma nota diz o que o sistema faz e por que esse é o comportamento
adotado, não uma proposta a aprovar.

## Nota de decisão × ADR

`docs/adr/` é para decisão de **arquitetura ou contrato público**: muda como
o sistema é construído ou o que ele promete para fora, e passa pelo gate
humano de aceitar ADR — OK explícito do owner; silêncio não é aprovação
(`docs/adr/0004-trabalho-autonomo.md`, item 9).

Uma nota de decisão é para **doutrina e comportamento**: um fato sobre como o
runtime já se comporta (medido, não hipotético), a decisão de manter esse
comportamento como contrato em vez de tratá-lo como bug, e a orientação que
disso decorre para quem escreve spec ou código. Não aciona o gate humano de
aceitar ADR; uma PR que só toca a nota é classe `docs` (ADR 0004, item 7):
CI basta, sem revisor — uma PR que também toca código (como a #271, que
adicionou o teste de contenção junto da nota) segue a classe do resto do
diff.

Na dúvida: se a nota descreve uma escolha de estrutura ou uma promessa nova
para quem usa o sistema, é ADR. Se descreve o que o código já faz e formaliza
isso como intencional, é nota de decisão.

## Formato

Nome: `YYYY-MM-DD-<slug>.md`, data do dia em que a decisão foi escrita.

Seções, modeladas na nota existente
(`2026-09-10-fanout-fs-compartilhado.md`):

- Cabeçalho com `**Data:**` e `**Origem:**` (issue, PR, experimento ou
  avaliação que motivou a nota).
- `## Contexto` — o comportamento medido, com `arquivo:linha` real.
- `## Decisão` — o que fica valendo, em bullets verificáveis.
- Uma seção de justificativa (por exemplo um `### Por que …` contra um
  invariante já documentado) quando a decisão precisa se explicar contra
  algo existente.
- `## Doutrina para autores de spec` — quando a decisão orienta como se
  desenha algo, não só o que o runtime faz. Omitida quando não há
  orientação prática a dar.
- `## Evidência` — o teste ou a execução que prende o comportamento descrito.

Uma PR que adiciona uma nota nova acrescenta a linha correspondente ao índice
abaixo.

## Índice

- [2026-09-10 — Fan-out sobre diretório
  compartilhado](2026-09-10-fanout-fs-compartilhado.md) — um working root por
  run, não por branch; duas folhas escrevendo o mesmo arquivo, a última
  escrita vence silenciosamente; doutrina de um arquivo por folha.
- [2026-09-10 — Skills nos harnesses: instalar no `init`, atualizar no
  `update`](2026-09-10-skills-harness.md) — relatório de exploração; decisão
  do owner pendente.
