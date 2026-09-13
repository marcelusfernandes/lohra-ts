// Issue #576 (épico #575): tipos do harness de eval de comportamento —
// casos (`tests/fixtures/eval/<id>.json`), oráculos de mecanismo (contra o
// stub, determinístico) e o resultado por caso (`results.jsonl`).
// Nenhum tipo aqui depende de I/O; quem lê disco é `case.ts` e `run.ts`.

/** Um passo scriptado de `chat-lane-script` (mirror de `StubLaneStep`, mas
 * só os campos que um caso de eval usa — sem `signal`/`gate`, que servem
 * coordenação entre lanes concorrentes, fora do escopo de um caso único). */
export interface EvalStubToolCall {
  readonly name: string;
  readonly argumentsRaw: string;
}

export interface EvalStubStep {
  readonly kind: "text" | "tool_calls" | "http_error";
  readonly content?: string;
  readonly calls?: readonly EvalStubToolCall[];
  readonly status?: number;
  readonly message?: string;
}

/** Uma lane por nome; `"default"` é a única lida quando o prompt do caso
 * não contém um marcador `SCEN:<lane>` (ver `scripts/stub/server.ts`). */
export type EvalStubScript = Readonly<Record<string, readonly EvalStubStep[]>>;

/** Uma requisição capturada do log projetado do stub (`recordRequest` em
 * `scripts/stub/server.ts`), só os campos que um oráculo de mecanismo lê. */
export interface CapturedRequest {
  readonly seq: number;
  readonly method: string;
  readonly path: string;
  readonly body: {
    readonly messages?: readonly Record<string, unknown>[];
    readonly tools?: readonly { readonly function?: { readonly name?: string } }[];
  };
}

export type MechanismAssertion =
  | {
      readonly kind: "system_prompt_includes";
      readonly substring: string;
      readonly request?: number;
    }
  | {
      readonly kind: "system_prompt_excludes";
      readonly substring: string;
      readonly request?: number;
    }
  | { readonly kind: "request_count"; readonly count: number }
  | {
      readonly kind: "message_roles_at_request";
      readonly request: number;
      readonly roles: readonly string[];
    }
  | {
      readonly kind: "tool_result_includes";
      readonly request: number;
      readonly substring: string;
    }
  | {
      readonly kind: "message_content_includes";
      readonly request: number;
      readonly substring: string;
    }
  | { readonly kind: "envelope_pointer"; readonly pointer: string; readonly value: unknown }
  | { readonly kind: "tools_include"; readonly request: number; readonly name: string }
  | { readonly kind: "tools_exclude"; readonly request: number; readonly name: string };

export interface EvalCaseFixture {
  readonly path: string;
  readonly content: string;
}

export interface EvalOutcome {
  readonly question: string;
  readonly expect: string;
}

/** Uma turno pré-persistido na sessão do caso, ANTES da CLI rodar — o
 * mesmo padrão de `tests/chat-compaction-events.test.ts` (seed direto via
 * `SessionRepository.recordTurn`), necessário porque `preflightCompact`
 * (`src/conversation/runtime.ts`) só encontra histórico para dobrar quando
 * já existem turnos PERSISTIDOS de uma sessão anterior — um turno único e
 * novo nunca tem nada para compactar (ver nota em `session.ts`). */
export interface EvalSeedTurn {
  readonly user: string;
  readonly assistant: string;
}

export interface EvalCase {
  readonly id: string;
  readonly input: string;
  readonly cwdFixture?: EvalCaseFixture;
  readonly stubScript: EvalStubScript;
  readonly mechanism: readonly MechanismAssertion[];
  readonly outcome: EvalOutcome;
  readonly budgetTokens: number;
  /** Turnos seedados numa sessão fixa (`--session <id>`) antes da chamada
   * real — só faz sentido junto de `contextWindowOverride`, para forçar
   * `preflightCompact` a compactar de verdade essa história seedada. */
  readonly sessionSeed?: readonly EvalSeedTurn[];
  /** Vira `LOHRA_CONTEXT_WINDOW` no ambiente da chamada — baixo o
   * suficiente para que a história seedada estoure o orçamento e force uma
   * compactação real. */
  readonly contextWindowOverride?: number;
  /** Nota livre para coordenação entre sub-issues (ex.: qual linha deste
   * caso muda quando outra issue do épico mergear). Nunca lida pelo
   * runner — só documentação dentro do próprio fixture. */
  readonly note?: string;
}

export interface MechanismResult {
  readonly kind: MechanismAssertion["kind"];
  readonly passed: boolean;
  readonly detail: string;
}

export type OutcomeVerdict = "pass" | "fail" | "no-signal";

export interface OutcomeResult {
  readonly question: string;
  readonly verdict: OutcomeVerdict;
}

export type EvalMode = "stub" | "provider";

/** Tri-estado, nunca um booleano fabricado: `true`/`false` só existem
 * quando o oráculo de mecanismo REALMENTE rodou (modo stub, com o stub
 * capturando as requisições cruas); `"skipped"` é honesto sobre modo
 * "provider" nunca ter tido como avaliar mecanismo nenhum — não existe
 * "provedor real, sem stub, mas mecanismoOk: true" (rodada 1 desta issue
 * fazia exatamente isso, achado do revisor: uma falha silenciosa, CLAUDE.md
 * invariante 2). */
export type MechanismVerdict = boolean | "skipped";

export interface EvalResultLine {
  readonly id: string;
  readonly mode: EvalMode;
  readonly provider?: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly error: string | null;
  readonly apiCalls: number;
  readonly usageTotal: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly budgetTokens: number;
  readonly budgetExceeded: boolean;
  readonly mechanism: readonly MechanismResult[];
  readonly mechanismOk: MechanismVerdict;
  readonly mechanismSkippedReason?: string;
  readonly outcome: OutcomeResult | null;
  readonly elapsedMs: number;
}

export interface EvalSummaryCase {
  readonly id: string;
  readonly mechanismOk: MechanismVerdict;
  readonly outcomeVerdict: OutcomeVerdict | "n/a";
  readonly totalTokens: number | null;
  readonly budgetExceeded: boolean;
}

export interface EvalSummary {
  readonly generatedAt: string;
  readonly mode: EvalMode;
  readonly provider?: string;
  readonly total: number;
  /** Só conta linhas com `mechanismOk === true` — nunca inclui "skipped". */
  readonly mechanismPassCount: number;
  /** Linhas com `mechanismOk === "skipped"` (sempre 21/21 em modo provider
   * hoje — o oráculo de mecanismo nunca roda sem o stub capturando as
   * requisições cruas). */
  readonly mechanismSkippedCount: number;
  readonly outcomePassCount: number;
  readonly cases: readonly EvalSummaryCase[];
}
