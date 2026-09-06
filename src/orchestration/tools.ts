import { ProviderError } from "../agent/client-pool.js";
import { jsonFloat } from "../serialization/json-numbers.js";
import { pythonRepr } from "../serialization/python-repr.js";
import { toolError, toolResult } from "../tools/envelope.js";
import type { ToolArguments } from "../tools/types.js";
import {
  summarizeCollectResult,
  type CollectResult,
  type OrchestrationCore,
  type SpawnConfig,
} from "./core.js";
import {
  coercePrompt,
  coerceTasks,
  validateCollectSubId,
  validateDelegateTasks,
  validateMaxIterations,
  validateResumeOverrides,
  validateResumeTasks,
  validateSpawnPrompt,
  validateSteerArgs,
} from "./validation.js";

/** "no sub-session 'deadbeef'" — the oracle's repr() of the sub_id, single
 * quotes (L19). sub_id values are always uuid4().hex in practice, but a
 * caller can pass a coerced non-string; repr() is used regardless so this
 * never silently diverges for an unusual value. */
function noSubSession(subId: string): string {
  return toolError(`no sub-session ${pythonRepr(subId)}`);
}

function overridesFromArgs(args: ToolArguments): Omit<SpawnConfig, "prompt"> {
  return {
    ...(typeof args.model === "string" ? { model: args.model } : {}),
    ...(typeof args.provider === "string" ? { provider: args.provider } : {}),
    ...(typeof args.effort === "string" ? { effort: args.effort } : {}),
    ...(typeof args.max_iterations === "number" ? { maxIterations: args.max_iterations } : {}),
  };
}

/** The narrow slice of ClientPool that the egress tripwire needs — a real
 * ClientPool satisfies this structurally. Kept narrow so tests don't have
 * to construct a real provider/client pair to exercise spawn_session. */
export interface ProviderResolver {
  get(name: string): Promise<unknown>;
}

/** contract L13/assertion 35: an unknown or unauthorized provider override
 * must produce zero upstream requests and zero subsession registry rows —
 * checked BEFORE core.spawn() is ever called, not inside the child's own
 * (already-defensive, per L17) error handling, since that path only runs
 * after the registry entry already exists. */
export async function spawnSessionTool(
  core: OrchestrationCore,
  clientPool: ProviderResolver,
  args: ToolArguments,
): Promise<string> {
  const promptError = validateSpawnPrompt(args);
  if (promptError !== null) return promptError;
  const maxIterationsError = validateMaxIterations(args.max_iterations);
  if (maxIterationsError !== null) return maxIterationsError;
  const provider =
    typeof args.provider === "string" && args.provider.length > 0 ? args.provider : null;
  if (provider !== null) {
    try {
      await clientPool.get(provider);
    } catch (error) {
      if (error instanceof ProviderError) return toolError(error.message);
      throw error;
    }
  }
  const { subId } = core.spawn({ prompt: coercePrompt(args.prompt), ...overridesFromArgs(args) });
  return toolResult(undefined, { sub_id: subId });
}

export function steerSessionTool(core: OrchestrationCore, args: ToolArguments): string {
  const argsError = validateSteerArgs(args);
  if (argsError !== null) return argsError;
  const subId = args.sub_id as string;
  const outcome = core.steer(subId, args.text as string);
  if (outcome === null) return noSubSession(subId);
  return toolResult(undefined, { queued: outcome.queued });
}

/** Maps the registry's CollectResult (camelCase) to the wire's snake_case
 * envelope, in the contract's exact 13-key order (assertion 14). retry_after
 * is the oracle's own `seconds if seconds > 0 else None` (L15/assertion 39) —
 * a Python float, so a whole-number value like 1 renders as "1.0", never the
 * bare "1" a plain JS number would produce. */
function collectEnvelope(result: CollectResult): string {
  return toolResult(undefined, {
    status: result.status,
    output: result.output,
    tokens_in: result.tokensIn,
    tokens_out: result.tokensOut,
    cache_read_tokens: result.cacheReadTokens,
    cache_write_tokens: result.cacheWriteTokens,
    reasoning_tokens: result.reasoningTokens,
    provider: result.provider,
    model: result.model,
    forced_fallback: result.forcedFallback,
    error_kind: result.errorKind,
    retry_after: result.retryAfter === null ? null : jsonFloat(result.retryAfter),
  });
}

export async function collectSessionTool(
  core: OrchestrationCore,
  args: ToolArguments,
): Promise<string> {
  const subIdError = validateCollectSubId(args);
  if (subIdError !== null) return subIdError;
  const subId = String(args.sub_id);
  const wait = args.wait === true;
  const outcome = await core.collect(subId, wait);
  if (outcome.kind === "not-found") return noSubSession(subId);
  if (outcome.kind === "settled") return collectEnvelope(outcome.result);
  // "pending" (wait:false, not yet settled): the oracle's exact envelope for
  // this poll is NOT measured anywhere in the baseline evidence (searched;
  // no "status":"running" collect capture exists) — this shape is a
  // reasonable placeholder, not a verified claim, and must not be cited as
  // byte-exact until measured against the real oracle.
  return toolResult(undefined, {
    status: "running",
    output: "",
    tokens_in: 0,
    tokens_out: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    reasoning_tokens: 0,
    provider: null,
    model: null,
    forced_fallback: false,
    error_kind: null,
    retry_after: null,
  });
}

export async function delegateTaskTool(
  core: OrchestrationCore,
  args: ToolArguments,
): Promise<string> {
  const resumeOverridesError = validateResumeOverrides(args);
  if (resumeOverridesError !== null) return resumeOverridesError;

  if (args.resume_id !== undefined) {
    const resumeTasksError = validateResumeTasks(args);
    if (resumeTasksError !== null) return resumeTasksError;
    const coerced = coerceTasks(args.tasks) as readonly unknown[];
    const followUp = typeof coerced[0] === "string" ? coerced[0] : String(coerced[0]);
    const resumeId: unknown = args.resume_id;
    const subId = String(resumeId);
    const steerOutcome = core.steer(subId, followUp);
    if (steerOutcome === null) return noSubSession(subId);
    const collectOutcome = await core.collect(subId, true);
    if (collectOutcome.kind !== "settled") return noSubSession(subId);
    const { result } = collectOutcome;
    return toolResult(undefined, {
      results: [
        {
          sub_id: subId,
          status: result.status,
          summary: summarizeCollectResult(result),
        },
      ],
    });
  }

  const tasksOrError = validateDelegateTasks(args);
  if (typeof tasksOrError === "string") return tasksOrError;
  const { tasks } = tasksOrError;
  const maxIterationsError = validateMaxIterations(args.max_iterations);
  if (maxIterationsError !== null) return maxIterationsError;
  const outcomes = await core.delegate(tasks, overridesFromArgs(args));
  return toolResult(undefined, {
    results: outcomes.map((outcome) => ({
      sub_id: outcome.subId,
      status: outcome.status,
      summary: outcome.summary,
    })),
  });
}
