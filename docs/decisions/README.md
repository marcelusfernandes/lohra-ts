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
- [2026-09-10 — Markdown de skill é doutrina — classe `docs` no
  `controle-negativo`](2026-09-10-skill-markdown-classe-docs.md) —
  `assets/skills/**/*.md` conta como classe docs/process; `assets/**`
  não-markdown continua feature; refinamento da ADR 0004 item 7, revisor
  continua obrigatório pelo hook.
- [2026-09-10 — Escopo na identidade da célula de cache — irmãos aninhados
  idênticos](2026-09-10-cache-escopo-irmaos.md) — `nodeScope` dobrado em
  `specIdentity` (não uma função por call site); sem dedupe entre irmãos
  idênticos, mesma direção que #319 tomou para checkpoint; registra a
  lacuna do `rename_hint` e a colisão de `sub[${reference}]:${nodeId}` como
  fora de escopo.
- [2026-09-12 — Sinal no ledger: `reason: signal` distingue SIGTERM/SIGINT
  de `workflow_cancel`](2026-09-12-sinal-no-ledger.md) —
  `registerShutdownTrigger` cobre SIGTERM e SIGINT com um handler só;
  `WorkflowService.shutdown("signal")` leva a causa até `segment.completed`
  (`{status: "interrupted", reason: "signal"}`), enquanto `cancel(runId)`
  passa a gravar `reason: "cancelled"` explícito, nunca `"signal"`.
- [2026-09-12 — Envelope de `delegate_task` cresce no fim; `dead_turn` é
  kind próprio](2026-09-12-envelope-delegate-aditivo.md) — `ERROR_KINDS`
  9 → 10 (`dead_turn`, produzido em `child-runner.ts`, nunca `unknown`);
  `results[i]` de `delegate_task` ganha `error_kind, tokens_in, tokens_out,
provider, model` no fim (precedente #232); remover/reordenar continua
  #419.
- [2026-09-12 — Pausa por recusa de rota: `route_fault` com lição
  estruturada](2026-09-12-pausa-por-recusa-de-rota.md) —
  `auth_failed`/`route_fault`/`model_not_found` pausam o run com o 5º
  `pause_reason` e uma lição `{error_kind, node_id, provider, model,
suggested_route}`; kind que pausa nunca entra em `faultKinds`; primeiro a
  pausar vence entre rota e quota; override de rota no resume (S6);
  `suggested_route` deixou de ser sempre `null` desde #459/#460 (M11,
  atualização datada na própria nota).
- [2026-09-13 — Flags de rota com assinatura ativa: fail-fast, não override
  por invocação](2026-09-13-flags-de-rota-com-assinatura.md) — em modo
  `subscription`, `--provider` explícito (com ou sem `--model`) devolve
  `initializationError` citando `lohra auth prefer api_key`, antes de
  qualquer rede; `--model` sozinho continua indo ao Codex; override por
  invocação (opção B) fica como possível issue futura.
- [2026-09-13 — Envelope de rotas do operador: `suggested_route` deixa de
  ser sempre `null`](2026-09-13-envelope-de-rotas.md) — `workflow_routes.json`
  fail-closed (molde `readTiers`); `suggestRoute` pura escolhe o primeiro
  fallback não tentado neste run; `withSuggestedRoute` enriquece a lição no
  terminal do service antes de todo leitor; só um HINT — aplicar a
  sugestão automaticamente no resume é S2 (#460); sem
  `max_fallbacks_per_run`, o teto continua `MAX_ROUTE_PIVOTS_PER_RUN`.
- [2026-09-13 — Canal do pivô de rota: `route_envelope` aplica sozinho,
  `operator` sempre vence](2026-09-13-canal-route-envelope.md) — resume sem
  `route` de um run pausado `route_fault` aplica `suggested_route`
  automaticamente (canal `route_envelope`); `route` explícito continua
  livre e sempre vence (canal `operator`); teto único de 3 pivôs
  compartilhado pelos dois canais, assimétrico no teto (explícito recusado,
  sem-rota fica parado); `node.rerouted` um por nó reescrito, `from`/`to`
  aninhados em `CONTAINER_FIELDS`; `AutoResumeScheduler` não re-arma
  `route_fault`.
- [2026-09-13 — Carimbo da célula: `identity_version` marca, nunca
  invalida](2026-09-13-carimbo-da-celula.md) — decisão 3 do épico #458:
  carimbo ao lado da célula (nunca na chave); `version_state`
  `current`/`stale`/`unstamped` em `cache.replayed`; "chave versionada" do
  enunciado do milestone fica registrada como alternativa rejeitada.
- [2026-09-13 — `forced_fallback` sai do envelope de
  `collect_session`](2026-09-13-envelope-forced-fallback.md) — owner OK
  (issue #419) para a opção (a): `CollectResult.forcedFallback` removido
  (nunca teve produtor real, sempre `false`); envelope de `collect_session`
  repinado 13 → 12 chaves; `delegate_task` fica igual, nunca teve a chave.
- [2026-09-13 — Abort em voo: três itens resolvidos por observação, um ainda
  aberto](2026-09-13-abort-em-voo-itens-a-definir.md) — fecha três dos
  quatro itens que a ADR 0005 deixou para a decomposição do épico #490:
  fórmula 2.9/2.4 + `input_tokens` do `message_start` (D1), `shutdown()`
  aborta em voo (D2); acrescenta o hook de steer armado por chamada, nunca
  por leaf inteiro (D3, que não é item da ADR). O quarto item da ADR (quais
  clientes streaming precisam de plumbing nova) foi resolvido por S1 (#516,
  PR #525): `error_kind`/`reason` uniforme para os três gatilhos
  (cancel/steer/timeout) segue genuinamente aberto — o timeout de folha
  (S6/#521) ainda fecha sem `error_kind` nem `usage`.
