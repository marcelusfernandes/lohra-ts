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
  | { readonly kind: "system_prompt_includes"; readonly substring: string }
  | { readonly kind: "system_prompt_excludes"; readonly substring: string }
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

export interface EvalCase {
  readonly id: string;
  readonly input: string;
  readonly cwdFixture?: EvalCaseFixture;
  readonly stubScript: EvalStubScript;
  readonly mechanism: readonly MechanismAssertion[];
  readonly outcome: EvalOutcome;
  readonly budgetTokens: number;
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
  readonly mechanismOk: boolean;
  readonly mechanismSkippedReason?: string;
  readonly outcome: OutcomeResult | null;
  readonly elapsedMs: number;
}

export interface EvalSummaryCase {
  readonly id: string;
  readonly mechanismOk: boolean;
  readonly outcomeVerdict: OutcomeVerdict | "n/a";
  readonly totalTokens: number | null;
  readonly budgetExceeded: boolean;
}

export interface EvalSummary {
  readonly generatedAt: string;
  readonly mode: EvalMode;
  readonly provider?: string;
  readonly total: number;
  readonly mechanismPassCount: number;
  readonly outcomePassCount: number;
  readonly cases: readonly EvalSummaryCase[];
}
