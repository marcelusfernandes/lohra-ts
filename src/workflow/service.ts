import { randomUUID } from "node:crypto";

import { Budget } from "./budget.js";
import { MemoryWorkflowCache, type WorkflowCache } from "./cache.js";
import type { WorkflowEvent, WorkflowLoader } from "./engine-contract.js";
import { WorkflowEngine } from "./engine.js";
import type { ChildRuntime } from "./runtime.js";
import { validateSpec } from "./schema.js";
import { ValidationError, type WorkflowSpec } from "./types.js";
import type { RunResult } from "./accounting.js";

interface RunRecord {
  readonly id: string;
  readonly name: string;
  readonly engine: WorkflowEngine;
  readonly promise: Promise<RunResult>;
  result: RunResult | null;
}

export interface WorkflowStartResult {
  readonly run_id: string;
  readonly name: string;
  readonly status: "running";
}

export interface WorkflowServiceError {
  readonly error: string;
  readonly invalid_spec?: boolean;
}

function resultView(runId: string, name: string, result: RunResult, budget: Budget) {
  return Object.freeze({
    run_id: runId,
    name,
    status: result.status,
    outputs: structuredClone(result.outputs),
    faults: Object.freeze([...result.faults]),
    null_count: result.nullCount,
    validation_retries: result.validationRetries,
    cap_trips: result.capTrips,
    engine_faults: result.engineFaults,
    nodes_total: result.nodesTotal,
    tokens_in: result.tokensIn,
    tokens_out: result.tokensOut,
    cache_read_tokens: result.cacheReadTokens,
    cache_write_tokens: result.cacheWriteTokens,
    reasoning_tokens: result.reasoningTokens,
    forcing_fallbacks: result.forcingFallbacks,
    pause_reason: result.pauseReason,
    checkpoint: result.checkpoint,
    token_budget: budget.snapshot(),
    null_rate: result.nullRate,
  });
}

export class WorkflowService {
  private readonly runs = new Map<string, RunRecord>();
  private readonly runtime: ChildRuntime;
  private readonly cache: WorkflowCache;
  private readonly loader: WorkflowLoader | undefined;
  private readonly idSource: () => string;
  private readonly onEvent: ((event: WorkflowEvent) => void) | undefined;

  constructor(options: {
    readonly runtime: ChildRuntime;
    readonly cache?: WorkflowCache;
    readonly loader?: WorkflowLoader;
    readonly idSource?: () => string;
    readonly onEvent?: (event: WorkflowEvent) => void;
  }) {
    this.runtime = options.runtime;
    this.cache = options.cache ?? new MemoryWorkflowCache();
    this.loader = options.loader;
    this.idSource = options.idSource ?? (() => randomUUID().replaceAll("-", ""));
    this.onEvent = options.onEvent;
  }

  start(
    rawSpec: unknown,
    args: Readonly<Record<string, unknown>> = {},
    options: {
      readonly checkpointAnswers?: Readonly<Record<string, unknown>>;
      readonly tokenBudget?: number | null;
    } = {},
  ): WorkflowStartResult | WorkflowServiceError {
    const parsed = validateSpec(rawSpec);
    if (parsed instanceof ValidationError)
      return Object.freeze({ error: parsed.message, invalid_spec: true });
    const id = this.idSource();
    const engine = new WorkflowEngine({
      runtime: this.runtime,
      cache: this.cache,
      budget: new Budget({ tokenBudget: options.tokenBudget ?? null }),
      runId: id,
      ...(this.loader === undefined ? {} : { loader: this.loader }),
      ...(options.checkpointAnswers === undefined
        ? {}
        : { checkpointAnswers: options.checkpointAnswers }),
      ...(this.onEvent === undefined ? {} : { onEvent: this.onEvent }),
    });
    const record = {} as RunRecord;
    const promise = engine.run(parsed, args).then((result) => {
      record.result = result;
      return result;
    });
    Object.assign(record, { id, name: parsed.name, engine, promise, result: null });
    this.runs.set(id, record);
    return Object.freeze({ run_id: id, name: parsed.name, status: "running" });
  }

  async runAndWait(
    spec: WorkflowSpec,
    args: Readonly<Record<string, unknown>> = {},
    options: { readonly tokenBudget?: number | null } = {},
  ) {
    const started = this.start(spec, args, options);
    if ("error" in started) return started;
    return this.status(started.run_id, true);
  }

  async status(runId: string, wait = false): Promise<Readonly<Record<string, unknown>> | WorkflowServiceError> {
    const record = this.runs.get(runId);
    if (record === undefined) return Object.freeze({ error: `unknown workflow run ${runId}` });
    if (wait && record.result === null) await record.promise;
    if (record.result === null)
      return Object.freeze({
        run_id: record.id,
        name: record.name,
        status: "running",
        progress: record.engine.progress(),
        token_budget: record.engine.budget.snapshot(),
      });
    return resultView(record.id, record.name, record.result, record.engine.budget);
  }

  list(): readonly Readonly<Record<string, unknown>>[] {
    return Object.freeze(
      [...this.runs.values()].map((record) =>
        Object.freeze({
          run_id: record.id,
          name: record.name,
          status: record.result?.status ?? "running",
          progress: record.engine.progress(),
        }),
      ),
    );
  }

  pause(runId: string): WorkflowServiceError | Readonly<Record<string, unknown>> {
    const record = this.runs.get(runId);
    if (record === undefined) return Object.freeze({ error: `unknown workflow run ${runId}` });
    record.engine.requestPause();
    return Object.freeze({ run_id: runId, status: "paused" });
  }

  cancel(runId: string): WorkflowServiceError | Readonly<Record<string, unknown>> {
    const record = this.runs.get(runId);
    if (record === undefined) return Object.freeze({ error: `unknown workflow run ${runId}` });
    record.engine.cancel();
    return Object.freeze({ run_id: runId, status: "cancelled" });
  }
}
