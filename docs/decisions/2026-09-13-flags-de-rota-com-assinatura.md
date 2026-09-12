# Flags de rota com assinatura ativa: fail-fast, não override por invocação

- **Data:** 2026-09-13
- **Origem:** issue #440 (achado de dogfooding da PR #439, issue #426);
  decisão do orquestrador antes do despacho.

## Contexto

Dogfooding da PR #439, 2026-09-12: com `auth_preference: "auto"` e uma
assinatura Codex ativa, `lohra chat --json --provider anthropic --model
claude-haiku-4-5-…` e `--provider openrouter --model …` falhavam com `400
model is not supported when using Codex with a ChatGPT account`. Em
`src/commands/chat.ts` (bloco `route.mode === "subscription"`, base
`:163-208`), `--provider` era ignorado de propósito — uma nota em stderr
(`subscription mode active — ignoring --provider …`) — mas `--model`
continuava sendo honrado (`model = stringFlag(options.flags, "--model") ??
readCodexModel(...) ?? "gpt-5.5"`) e enviado ao transporte Responses da
assinatura, que não aceita um modelo de outro provedor. A falha vinha do
provedor (400), não da fronteira do runtime.

## Decisão

Das duas opções levantadas na issue — (A) fail-fast e (B) override por
invocação — o orquestrador escolheu **(A)**:

- Em modo `subscription`, um `--provider` **explícito** (com ou sem
  `--model`) devolve `initializationError` — sem chamar `resolveCredentials`,
  sem POST de refresh, sem chamada de rede — nomeando a flag recebida e a
  ação corretiva: `lohra auth prefer api_key` (trocar a preferência) ou
  omitir `--provider`.
- `--model` **sozinho**, sem `--provider`, continua indo ao Codex sem
  mudança — é como o operador escolhe o modelo da própria assinatura, e não
  é afetado por esta decisão.
- A nota `subscriptionNote` (`"ignoring --provider …"`) sai do código: o
  comportamento que ela descrevia (ignorar a flag e seguir mesmo assim) é
  exatamente o que a recusa substitui.
- `src/auth/manage.ts` não muda: `auth_preference` continua um estado
  persistido, resolvido uma vez por processo (`resolveAuthRoute`), não uma
  decisão por invocação de `chat`.
- Issue #457: `src/commands/dashboard.ts` seguia o padrão antigo — pior,
  descartava `--provider` em silêncio total, sem nem a nota que `chat`
  tinha — e foi corrigido com a mesma guarda, extraída para
  `src/commands/subscription-guard.ts` para a mensagem ficar byte-igual nos
  dois comandos (`chat.ts` e `dashboard.ts`).

### Por que não (B)

(B) resolveria a rota de API key por invocação sempre que as variáveis do
provedor estivessem presentes, sem tocar a preferência persistida. Isso
mudaria a semântica de `auth_preference` (hoje: um estado só, lido uma vez
por `resolveAuthRoute`) para "preferência + override implícito por flag",
espalhando a decisão de rota entre `manage.ts` e cada comando que aceita
`--provider`. É coerente com o gate incondicional de assinatura de `lohra
serve` (`src/cli.ts:510`, que nunca aceita override) manter a mesma
disciplina em `chat`: uma única fonte de verdade para "qual rota esta
sessão usa". (B) fica registrada como possível issue futura, se houver
demanda concreta por override por invocação.

## Doutrina para autores de spec

Um comando novo que aceita `--provider`/`--model` e pode rodar sob
`auth_preference: "auto"` com assinatura ativa segue o mesmo padrão: recusar
`--provider` explícito antes de qualquer I/O relacionado à credencial —
nunca silenciar a flag e seguir com uma rota diferente da pedida.

## Evidência

- `tests/chat-subscription-provider-flag.test.ts`: `--provider` (com e sem
  `--model`) em modo subscription devolve `initializationError` citando
  `lohra auth prefer api_key`, com zero chamadas de rede; `--model` sozinho
  continua roteado ao transporte Responses (não-regressão).
- `tests/chat-subscription-refresh.test.ts`: continua verde — o tratamento
  de falha de refresh que este fix não pode quebrar.
- `tests/dashboard-subscription-provider-flag.test.ts` (issue #457): mesma
  recusa em `dashboard.ts`, com zero rede (stub de `fetch` e espião em
  `NativeChatHttpPort.prototype.post`) e não-regressão de `--model` sozinho
  provada por um turno real via WS até o transporte Responses.
- `npm run mutations:t17` (fatia `workflow-audit-live`) e
  `npm run mutations:self-update` — as duas fatias cujo `srcGlobs` cobre
  `src/commands/**` (`scripts/mutations/slices.json`) — sem sobreviventes.
  `npm run mutations:auth` cobre só `src/auth/**`; não exercita
  `src/commands/chat.ts` nem `src/commands/dashboard.ts`, ao contrário do
  que uma versão anterior desta nota afirmava.
