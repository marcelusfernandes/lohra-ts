import type { SystemBands } from "../transports/index.js";
import { ConversationError } from "./errors.js";
import type { ConversationRepository, StoredSession } from "./types.js";

export interface ResolveTurnSessionInput {
  readonly repository: ConversationRepository;
  /** `input.sessionId` from `runTurn`'s own caller, untouched — `undefined`
   * means the caller left session selection to `idSource` below. Needed
   * (not just the resolved id) to reproduce the pre-#649 rule verbatim: an
   * EXPLICIT id that doesn't resolve is `SESSION_NOT_FOUND`; an id this
   * function minted itself never is. */
  readonly sessionId: string | undefined;
  readonly idSource: () => string;
  readonly promptSnapshot: () => string | SystemBands;
  readonly model: string;
  readonly cwd: string;
}

export interface ResolveTurnSessionResult {
  readonly sessionId: string;
  readonly session: StoredSession;
  readonly created: boolean;
}

/**
 * Issue #649 (sub-issue B1 de #637): extraído de `ConversationRuntime.
 * runTurn` (`runtime.ts` estava em 796/800 linhas) — resolve a sessão de UM
 * turno e decide de onde vem `session.systemPrompt`, sem nenhum outro efeito
 * colateral do turno (histórico, transporte, etc, seguem em `runtime.ts`).
 *
 * Três casos:
 *
 * 1. Sessão explícita (`sessionId !== undefined`) que não existe no
 *    repositório: `SESSION_NOT_FOUND` — byte-idêntico ao throw que vivia em
 *    `runtime.ts` antes desta issue.
 * 2. Sessão nova (nenhum id explícito, ou id explícito que não colide com
 *    nada — `idSource()` minta um novo): `promptSnapshot()` é a única fonte,
 *    e as três faixas vão para `createSession` — a repository que entende
 *    faixas (`SqliteConversationRepository`) persiste as três.
 * 3. Sessão RETOMADA (`repository.session(id)` devolve algo): a leitura
 *    adotada em #637/#649 é que a sessão retomada É a mesma sessão, logo o
 *    prompt persistido É o prompt congelado (invariante 1, CLAUDE.md) —
 *    nunca reconstruído por uma closure que pode divergir entre processos.
 *    `volatile !== ""` é o discriminador: uma linha que `systemPromptBands`
 *    já entendeu como faixas sempre carrega a data ali (`system-prompt.ts`
 *    sempre anexa `Today's date is ...` à faixa `volatile`), então esse
 *    discriminador não tem falso positivo. Uma linha MIGRADA (pré-#586, ou
 *    `createSession` chamado com uma string — `context`/`volatile` vazias,
 *    o `stable` carregando o texto inteiro) cai em `promptSnapshot()` como
 *    antes desta issue: não há faixas de verdade para reusar.
 *
 * Consequências nomeadas da leitura 3 (não implícitas — ver
 * `docs/decisions/2026-09-14-faixas-restauradas.md`): a data em `volatile`
 * fica a da criação da sessão; memória/skills gravadas depois da criação não
 * entram no prompt retomado; uma sessão pré-doutrina retomada continua sem
 * doutrina (item 10 do veredito da PR #610 fecha por construção).
 */
export function resolveTurnSession(input: ResolveTurnSessionInput): ResolveTurnSessionResult {
  const sessionId = input.sessionId ?? input.idSource();
  const existing = input.repository.session(sessionId);
  if (input.sessionId !== undefined && existing === null) {
    throw new ConversationError("SESSION_NOT_FOUND", `session not found: ${sessionId}`, {
      sessionId,
    });
  }
  if (existing === null) {
    const systemPrompt = input.promptSnapshot();
    input.repository.createSession({
      id: sessionId,
      systemPrompt, // #586 (2ª rodada): a repository que entende faixas persiste as três
      model: input.model,
      cwd: input.cwd,
    });
    return {
      sessionId,
      session: { systemPrompt, model: input.model, cwd: input.cwd },
      created: true,
    };
  }
  const persistedPrompt = existing.systemPrompt;
  const restoredBandsUnderstood =
    typeof persistedPrompt !== "string" && persistedPrompt.volatile !== "";
  const session = restoredBandsUnderstood
    ? existing
    : { ...existing, systemPrompt: input.promptSnapshot() };
  return { sessionId, session, created: false };
}
