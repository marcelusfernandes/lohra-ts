// Issue #576: junta sessão (`session.ts`) e oráculos (`oracles.ts`) numa
// `EvalResultLine` por caso. O oráculo de mecanismo só roda em modo "stub"
// — em modo "provider" não há stub local interceptando a chamada real, e
// fingir um veredito de mecanismo contra dado que não existe seria uma
// falha silenciosa (CLAUDE.md, invariante 2); por isso `mechanismOk` é o
// literal `"skipped"` nesse modo (rodada 2: `true` fixo era exatamente essa
// falha silenciosa — `mechanismPassCount`/`results.jsonl` afirmavam
// mecanismo aprovado sem nenhuma assertion ter rodado), com
// `mechanismSkippedReason` explicando por quê.
import { evaluateMechanism, evaluateOutcome } from "./oracles.js";
import type { runEvalCase as RunEvalCaseFn, EvalRunOptions } from "./session.js";
import type { EvalCase, EvalResultLine } from "./types.js";

export type SessionRunner = typeof RunEvalCaseFn;

function readUsageTotal(
  envelope: Record<string, unknown> | null,
): { readonly inputTokens: number; readonly outputTokens: number } | null {
  const usage = envelope?.usage_total;
  if (typeof usage !== "object" || usage === null) return null;
  const record = usage as Record<string, unknown>;
  const inputTokens = record.input_tokens;
  const outputTokens = record.output_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return null;
  return { inputTokens, outputTokens };
}

function readOutput(envelope: Record<string, unknown> | null): string | null {
  const output = envelope?.output;
  return typeof output === "string" ? output : null;
}

function readError(
  envelope: Record<string, unknown> | null,
  envelopeParseError: string | null,
): string | null {
  const fromEnvelope = envelope?.error;
  if (typeof fromEnvelope === "string") return fromEnvelope;
  return envelopeParseError;
}

function readApiCalls(envelope: Record<string, unknown> | null): number {
  const apiCalls = envelope?.api_calls;
  return typeof apiCalls === "number" ? apiCalls : 0;
}

/** Roda um único caso e produz a linha de resultado — nunca lança: um erro
 * de sessão (spawn falhou, timeout) vira uma linha com `error` preenchido,
 * não uma exceção que perderia o progresso do lote (ver `run.ts`). */
export async function runCaseToResultLine(
  kase: EvalCase,
  options: EvalRunOptions,
  runSession: SessionRunner,
): Promise<EvalResultLine> {
  const startedAt = Date.now();
  const session = await runSession(kase, options);
  const isProviderMode = options.provider !== undefined;
  const mechanism = isProviderMode
    ? []
    : evaluateMechanism(kase.mechanism, session.requests, session.envelope);
  const mechanismOk: EvalResultLine["mechanismOk"] = isProviderMode
    ? "skipped"
    : mechanism.every((result) => result.passed);
  const outcome = evaluateOutcome(kase.outcome, readOutput(session.envelope));
  const usageTotal = readUsageTotal(session.envelope);
  const totalTokens = usageTotal === null ? null : usageTotal.inputTokens + usageTotal.outputTokens;
  const budgetExceeded = totalTokens !== null && totalTokens > kase.budgetTokens;
  return {
    id: kase.id,
    mode: isProviderMode ? "provider" : "stub",
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    exitCode: session.exitCode,
    timedOut: session.timedOut,
    error: readError(session.envelope, session.envelopeParseError),
    apiCalls: readApiCalls(session.envelope),
    usageTotal,
    budgetTokens: kase.budgetTokens,
    budgetExceeded,
    mechanism,
    mechanismOk,
    ...(isProviderMode
      ? { mechanismSkippedReason: "modo provider: sem stub local capturando requisições" }
      : {}),
    outcome,
    elapsedMs: Date.now() - startedAt,
  };
}

/** Uma exceção da própria sessão (ex.: `spawn` falhou por um motivo que não
 * é timeout) também vira uma linha de resultado, nunca propaga — quem chama
 * (`run.ts`) grava a linha e segue para o próximo caso, preservando o que
 * já rodou. */
export async function runCaseSafely(
  kase: EvalCase,
  options: EvalRunOptions,
  runSession: SessionRunner,
): Promise<EvalResultLine> {
  try {
    return await runCaseToResultLine(kase, options, runSession);
  } catch (error) {
    return {
      id: kase.id,
      mode: options.provider === undefined ? "stub" : "provider",
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      exitCode: 1,
      timedOut: false,
      error: `eval: sessão falhou: ${String(error)}`,
      apiCalls: 0,
      usageTotal: null,
      budgetTokens: kase.budgetTokens,
      budgetExceeded: false,
      mechanism: [],
      // Uma sessão que lança em modo provider nunca chegou nem perto de
      // avaliar mecanismo (não havia stub para capturar) — "skipped" é o
      // veredito honesto, igual ao caminho feliz do mesmo modo, nunca
      // `false` (que implicaria uma assertion real ter rodado e falhado).
      mechanismOk: options.provider === undefined ? false : "skipped",
      outcome: { question: kase.outcome.question, verdict: "no-signal" },
      elapsedMs: 0,
    };
  }
}
