import { randomUUID } from "node:crypto";

import { Budget } from "./budget.js";
import { MemoryWorkflowCache, type WorkflowCache } from "./cache.js";
import type { WorkflowEvent, WorkflowLoader } from "./engine-contract.js";
import { WorkflowEngine } from "./engine.js";
import { LeaseHeartbeat } from "./durability.js";
import type { ChildRuntime } from "./runtime.js";
import { validateSpec } from "./schema.js";
import { ValidationError, type WorkflowSpec } from "./types.js";
import type { RunResult } from "./accounting.js";
import type { Ownership } from "../state/workflow-repository.js";
import { WorkflowRepository } from "../state/workflow-repository.js";
import type { LockRepository } from "../state/locks.js";

export const RUN_LEASE_TTL = 900;
export const FENCE_MEMORY = 1024;
export const RECOVERED_FAULT = "recovered after process loss";
export const CHECKPOINT_PAUSE = "checkpoint";
export const QUOTA_PAUSE = "quota_exhausted";
export const TOKEN_BUDGET_PAUSE = "token_budget_exhausted";
export const USER_PAUSE = "user_requested";

const STALE_HINT =
  "the process that was running this workflow was lost before it finished; the " +
  "cells it completed are kept — run_workflow(resume_run_id=...) continues it";
const BUSY_HINT = "another process is running this workflow right now";
const TOKEN_BUDGET_HINT =
  "the run spent its token budget; nothing will resume it on its own — " +
  "run_workflow(resume_run_id=..., token_budget=<more than 'spent'>)";
const CHECKPOINT_HINT =
  "this run is paused at a checkpoint waiting for your answer — " +
  'run_workflow(resume_run_id=..., checkpoint_answers={"<node_id>": ' +
  "<answer>}); a checkpoint that declared a 'default' takes it if " +
  "you resume without one";
const USER_PAUSE_HINT =
  "you paused this run; nothing will resume it on its own — its " +
  "finished nodes are kept, so run_workflow(resume_run_id=...) " +
  "continues it whenever you want (no budget raise needed)";

export interface DurableRunView {
  readonly run_id: string;
  readonly name: string;
  readonly owner: string | null;
  readonly status: string;
  readonly pause_reason: string | null;
  readonly checkpoint: Record<string, unknown> | null;
  readonly resume_at: number | null;
  readonly attempts: number;
  readonly prior_faults: readonly string[];
  readonly prior_degraded: boolean;
  readonly tainted: boolean;
  readonly spec: Record<string, unknown> | null;
  readonly args: Readonly<Record<string, unknown>>;
  readonly token_budget: number | null;
  readonly progress: Record<string, unknown> | null;
  readonly audit_segment_id: string | null;
  readonly updated_at: number;
}

function loads(raw: unknown, fallback: unknown): unknown {
  if (typeof raw !== "string" || raw === "") return fallback;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return fallback;
  }
}

export function durableFromRow(row: Readonly<Record<string, unknown>>): DurableRunView {
  const payload = loads(row.pause_payload_json, {}) as Record<string, unknown>;
  const faults = payload.prior_faults;
  const checkpoint = payload.checkpoint;
  const progress = loads(row.progress_json, null);
  const spec = loads(row.spec_json, null);
  const args = loads(row.args_json, {});
  return {
    run_id: String(row.run_id),
    name: typeof row.name === "string" ? row.name : "",
    owner: typeof row.owner === "string" ? row.owner : null,
    status: typeof row.status === "string" ? row.status : "running",
    pause_reason: typeof row.pause_reason === "string" ? row.pause_reason : null,
    checkpoint:
      checkpoint !== null && typeof checkpoint === "object"
        ? (checkpoint as Record<string, unknown>)
        : null,
    resume_at: typeof payload.resume_at === "number" ? payload.resume_at : null,
    attempts: Number(payload.attempts ?? 0),
    prior_faults: Array.isArray(faults) ? faults.map((fault) => String(fault)) : [],
    prior_degraded: payload.prior_degraded === true,
    tainted: Number(row.tainted ?? 0) === 1,
    spec: spec !== null && typeof spec === "object" ? (spec as Record<string, unknown>) : null,
    args: args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {},
    token_budget:
      row.token_budget === null || row.token_budget === undefined
        ? null
        : Number(row.token_budget),
    progress:
      progress !== null && typeof progress === "object"
        ? (progress as Record<string, unknown>)
        : null,
    audit_segment_id:
      row.audit_segment_id === null || row.audit_segment_id === undefined
        ? null
        : (row.audit_segment_id as string),
    updated_at: Number(row.updated_at ?? 0),
  };
}

export function pauseFields(
  view: DurableRunView,
): Readonly<Record<string, unknown>> | null {
  if (view.status !== "paused") return null;
  const fields: Record<string, unknown> = {
    reason: view.pause_reason,
    resume_at: view.resume_at,
    attempts: view.attempts,
  };
  if (view.pause_reason === TOKEN_BUDGET_PAUSE) {
    fields.hint = TOKEN_BUDGET_HINT;
  } else if (view.pause_reason === CHECKPOINT_PAUSE) {
    fields.checkpoint = view.checkpoint;
    fields.hint = CHECKPOINT_HINT;
  } else if (view.pause_reason === USER_PAUSE) {
    fields.hint = USER_PAUSE_HINT;
  }
  return Object.freeze(fields);
}

export function durableRollup(
  view: DurableRunView,
  spentTotal: number,
  stale: boolean,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = { run_id: view.run_id, status: view.status };
  const pause = pauseFields(view);
  if (pause !== null) Object.assign(out, pause);
  out.tokens_spent_total = spentTotal;
  if (view.progress !== null && Number(view.progress.total ?? 0) > 0) out.progress = view.progress;
  if (view.prior_faults.length > 0) out.faults_total = [...view.prior_faults];
  if (view.name !== "") out.name = view.name;
  if (view.status === "running") {
    out.stale = stale;
    out.hint = stale ? STALE_HINT : BUSY_HINT;
  }
  return Object.freeze(out);
}

export function busyErrorMessage(runId: string, expiry: number | null, now: number): string {
  const remaining = expiry !== null ? Math.max(0, Math.trunc(expiry - now)) : 0;
  return (
    `workflow run '${runId}' is being resumed by another process (its lease ` +
    `expires in ~${String(remaining)}s) — poll it with workflow_status instead of ` +
    "launching a second engine on the same run"
  );
}

export function refuseSpentBudgetMessage(
  runId: string,
  budget: number | null,
  spent: number,
): string | null {
  if (budget === null || spent < budget) return null;
  return (
    `workflow run '${runId}' has already spent ${String(spent)} tokens; a ` +
    `token_budget of ${String(budget)} would pause it again on its first spawn — ` +
    `resume it with a bigger one\n    e.g. token_budget: ${String(spent * 2)}`
  );
}

export interface OwnershipStore {
  readonly repository: WorkflowRepository;
  readonly locks: LockRepository;
  readonly holder: string;
  readonly ttl: number;
  readonly ownershipOf: () => Ownership;
}

export interface WorkflowStartResult {
  readonly run_id: string;
  readonly status: "started";
}

export interface WorkflowServiceError {
  readonly error: string;
  readonly invalid_spec?: boolean;
}

export interface OwnershipLost {
  readonly error: "workflow ownership lost";
  readonly cause: "STALE_FENCE_WRITE";
  readonly run_id: string;
  readonly fence: number;
}

export function ownershipLost(runId: string, fence: number): OwnershipLost {
  return Object.freeze({
    error: "workflow ownership lost" as const,
    cause: "STALE_FENCE_WRITE" as const,
    run_id: runId,
    fence,
  });
}

interface RunRecord {
  readonly id: string;
  readonly name: string;
  readonly engine: WorkflowEngine;
  readonly promise: Promise<Readonly<Record<string, unknown>>>;
  result: RunResult | null;
  readonly resolve: (value: Readonly<Record<string, unknown>>) => void;
  settled: boolean;
}

function resultView(
  runId: string,
  name: string,
  result: RunResult,
  budget: Budget,
): Readonly<Record<string, unknown>> {
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

function isLive(record: RunRecord | undefined): boolean {
  return record !== undefined && !record.settled;
}

export class WorkflowService {
  private readonly runs = new Map<string, RunRecord>();
  private readonly runtime: ChildRuntime;
  private readonly cache: WorkflowCache;
  private readonly loader: WorkflowLoader | undefined;
  private readonly idSource: () => string;
  private readonly onEvent: ((event: WorkflowEvent) => void) | undefined;
  private readonly store: OwnershipStore | undefined;
  private readonly cacheFactory: ((runId: string) => WorkflowCache) | undefined;
  private readonly heartbeat: LeaseHeartbeat | undefined;

  public constructor(options: {
    readonly runtime: ChildRuntime;
    readonly cache?: WorkflowCache;
    readonly loader?: WorkflowLoader;
    readonly idSource?: () => string;
    readonly onEvent?: (event: WorkflowEvent) => void;
    readonly store?: OwnershipStore;
    readonly cacheFactory?: (runId: string) => WorkflowCache;
  }) {
    this.runtime = options.runtime;
    this.cache = options.cache ?? new MemoryWorkflowCache();
    this.loader = options.loader;
    this.idSource = options.idSource ?? (() => randomUUID().replaceAll("-", ""));
    this.onEvent = options.onEvent;
    this.store = options.store;
    this.cacheFactory = options.cacheFactory;
    if (options.store !== undefined) {
      const store = options.store;
      this.heartbeat = new LeaseHeartbeat(
        (runId) =>
          store.locks.renewRunLease(runId, store.holder, store.ownershipOf().now, store.ttl),
        { interval: store.ttl / 3, timerFactory: () => ({ cancel: () => undefined }) },
      );
    }
  }

  // --- launch --------------------------------------------------------------

  start(
    rawSpec: unknown,
    args: Readonly<Record<string, unknown>> = {},
    options: {
      readonly checkpointAnswers?: Readonly<Record<string, unknown>>;
      readonly tokenBudget?: number | null;
      readonly resumeRunId?: string;
    } = {},
  ): WorkflowStartResult | WorkflowServiceError {
    const resumeRunId = options.resumeRunId;
    const explicitSpec = rawSpec !== undefined && rawSpec !== null;
    const prior = resumeRunId === undefined ? null : this.durableOf(resumeRunId);
    let specCandidate: unknown = rawSpec;
    if (!explicitSpec) {
      if (resumeRunId === undefined) {
        return Object.freeze({ error: "run_workflow needs a 'spec' object (with meta + nodes)" });
      }
      if (prior === null || prior.spec === null) {
        return Object.freeze({
          error:
            `no spec on file for workflow run '${resumeRunId}' — pass ` +
            `'spec' explicitly (nothing on disk names this run)`,
        });
      }
      specCandidate = prior.spec;
    }
    const parsed = validateSpec(specCandidate);
    if (parsed instanceof ValidationError) {
      return Object.freeze({ error: parsed.message, invalid_spec: true });
    }
    const budget = options.tokenBudget;
    if (
      budget !== undefined &&
      budget !== null &&
      (typeof budget !== "number" || !Number.isInteger(budget) || budget <= 0)
    ) {
      return Object.freeze({
        error:
          `token_budget must be a whole number of tokens greater than 0 (got ${String(budget)})\n` +
          "    e.g. token_budget: 200000",
      });
    }
    const runId = resumeRunId ?? this.idSource();
    const runArgs =
      resumeRunId === undefined
        ? args
        : Object.keys(args).length > 0
          ? args
          : (prior?.args ?? {});
    if (this.store === undefined) {
      return this.launch(parsed, runId, runArgs, options.checkpointAnswers ?? {}, budget ?? null);
    }
    return this.launchDurable(this.store, parsed, runId, runArgs, options, explicitSpec, prior);
  }

  private launch(
    parsed: WorkflowSpec,
    runId: string,
    args: Readonly<Record<string, unknown>>,
    checkpointAnswers: Readonly<Record<string, unknown>>,
    tokenBudget: number | null,
  ): WorkflowStartResult {
    const engine = new WorkflowEngine({
      runtime: this.runtime,
      cache: this.cache,
      budget: new Budget({ tokenBudget }),
      runId,
      ...(this.loader === undefined ? {} : { loader: this.loader }),
      ...(Object.keys(checkpointAnswers).length > 0 ? { checkpointAnswers } : {}),
      ...(this.onEvent === undefined ? {} : { onEvent: this.onEvent }),
    });
    const record = this.makeRecord(runId, parsed.name, engine);
    this.runs.set(runId, record);
    void engine
      .run(parsed, args)
      .then((result) => {
        record.result = result;
        record.settled = true;
        record.resolve(resultView(runId, parsed.name, result, engine.budget));
      })
      .catch(() => {
        record.settled = true;
        record.resolve({ run_id: runId, status: "failed", error: "workflow run failed" });
      });
    return Object.freeze({ run_id: runId, status: "started" as const });
  }

  // --- durable launch/resume -------------------------------------------------

  private launchDurable(
    store: OwnershipStore,
    parsed: WorkflowSpec,
    runId: string,
    args: Readonly<Record<string, unknown>>,
    options: {
      readonly checkpointAnswers?: Readonly<Record<string, unknown>>;
      readonly tokenBudget?: number | null;
      readonly resumeRunId?: string;
    },
    explicitSpec: boolean,
    priorView: DurableRunView | null,
  ): WorkflowStartResult | WorkflowServiceError {
    const resumeRunId = options.resumeRunId;
    const now = store.ownershipOf().now;
    const answers: Record<string, unknown> = { ...(options.checkpointAnswers ?? {}) };
    if (!explicitSpec && priorView !== null && priorView.status === "paused" && priorView.pause_reason === CHECKPOINT_PAUSE) {
      const pending = priorView.checkpoint ?? {};
      const nodeId = pending.node_id;
      if (typeof nodeId === "string" && nodeId !== "" && !(nodeId in answers)) {
        if ("default" in pending) answers[nodeId] = pending.default;
        else {
          const promptText =
            typeof pending.prompt === "string" ? pending.prompt : "";
          const nodeIdText: string = typeof nodeId === "string" ? nodeId : JSON.stringify(nodeId);
          return Object.freeze({
            error:
              `workflow run '${resumeRunId as string}' is paused at checkpoint '${nodeIdText}' ` +
              `and is waiting for an answer: ${promptText}\n` +
              `    e.g. checkpoint_answers: {"${nodeId}": "<your answer>"}`,
          });
        }
      }
    }
    const tainted = priorView?.tainted === true;
    const liveHere = this.runs.get(runId);
    const orphaned =
      resumeRunId !== undefined &&
      priorView !== null &&
      !isLive(liveHere) &&
      priorView.status === "running" &&
      store.locks.runLeaseExpiry(runId, now) === null;
    // Acquire BEFORE reading the spend: the seed must not read a ledger the
    // previous owner was still finishing.
    const fence = store.locks.acquireRunLease(runId, store.holder, store.ownershipOf().now, store.ttl);
    if (fence === null) {
      const expiry = store.locks.runLeaseExpiry(runId, store.ownershipOf().now);
      return Object.freeze({
        error: busyErrorMessage(runId, expiry, store.ownershipOf().now),
      });
    }
    this.heartbeat?.start(runId);
    const seeded = this.seedSpend(store, runId);
    const effectiveBudget =
      options.tokenBudget ?? (resumeRunId !== undefined ? (priorView?.token_budget ?? null) : null);
    const refusal = refuseSpentBudgetMessage(runId, effectiveBudget, seeded.tokensIn + seeded.tokensOut);
    if (refusal !== null) {
      this.heartbeat?.stop(runId);
      store.locks.releaseRunLease(runId, store.holder);
      return Object.freeze({ error: refusal });
    }
    const engine = new WorkflowEngine({
      runtime: this.runtime,
      budget: new Budget({
        tokenBudget: effectiveBudget,
        tokensIn: seeded.tokensIn,
        tokensOut: seeded.tokensOut,
      }),
      runId,
      ...(this.loader === undefined ? {} : { loader: this.loader }),
      ...(Object.keys(answers).length > 0 ? { checkpointAnswers: answers } : {}),
      ...(this.onEvent === undefined ? {} : { onEvent: this.onEvent }),
      ...(this.cacheFactory === undefined
        ? {}
        : { cache: this.cacheFactory(runId) }),
    });
    const record = this.makeRecord(runId, parsed.name, engine);
    const carriedFaults = [...(priorView?.prior_faults ?? [])];
    if (orphaned) {
      carriedFaults.push(
        `${runId}: ${RECOVERED_FAULT} — the process running it stopped before it finished; completed cells replayed, work in flight was lost`,
      );
    }
    const priorFaults = carriedFaults;
    const priorDegraded = priorView?.prior_degraded === true;
    this.runs.set(runId, record);
    this.persistLine(store, runId, {
      name: parsed.name,
      owner: store.holder,
      status: "running",
      pauseReason: null,
      pausePayloadJson: null,
      specJson: JSON.stringify(rawSpecOf(parsed)),
      argsJson: JSON.stringify(args),
      tokenBudget: effectiveBudget,
      tainted,
      progressJson: null,
      auditSegmentId: null,
      updatedAt: store.ownershipOf().now,
      fence,
      holder: store.holder,
      now: store.ownershipOf().now,
    });
    // The launch line presents the token of THIS acquisition for its writes:
    // keep a per-run ownership view pinned to the acquired fence so every
    // write of the stretch presents the same honest token.
    const stretchOwnership: Ownership = {
      fence,
      holder: store.holder,
      now: store.ownershipOf().now,
    };
    this.persistSpend(store, runId, effectiveBudget, seeded, engine, stretchOwnership);
    void engine
      .run(parsed, args)
      .then((result) => {
        record.result = result;
        const faults = [...priorFaults, ...result.faults];
        const degraded =
          priorDegraded ||
          result.faults.some((fault) => fault !== result.pauseFault);
        const owned = this.persistLine(store, runId, {
          name: parsed.name,
          owner: store.holder,
          status: result.status,
          pauseReason: result.pauseReason,
          pausePayloadJson:
            result.status === "paused"
              ? JSON.stringify({
                  checkpoint: result.checkpoint,
                  resume_at: null,
                  attempts: (priorView?.attempts ?? 0) + 1,
                  prior_faults: faults,
                  prior_degraded: degraded,
                })
              : JSON.stringify({
                  checkpoint: null,
                  resume_at: null,
                  attempts: (priorView?.attempts ?? 0) + 1,
                  prior_faults: faults,
                  prior_degraded: degraded,
                }),
          specJson: JSON.stringify(rawSpecOf(parsed)),
          argsJson: JSON.stringify(args),
          tokenBudget: effectiveBudget,
          tainted,
          progressJson: progressJsonOf(result),
          auditSegmentId: null,
          updatedAt: stretchOwnership.now,
          fence: stretchOwnership.fence,
          holder: stretchOwnership.holder,
          now: stretchOwnership.now,
        });
        this.persistSpend(store, runId, effectiveBudget, seeded, engine, stretchOwnership);
        // The heartbeat stops FIRST; a tick that outlived the release would put
        // the lease back and leave the run looking alive with nobody in it.
        this.heartbeat?.stop(runId);
        store.locks.releaseRunLease(runId, store.holder);
        record.settled = true;
        if (owned) {
          record.resolve(resultView(runId, parsed.name, result, engine.budget));
        } else {
          // Fail-closed (errata E2): a stretch that lost ownership never
          // publishes a terminal success; the waiter resolves bounded as ERROR.
          record.resolve(
            ownershipLost(runId, stretchOwnership.fence) as unknown as Readonly<Record<string, unknown>>,
          );
        }
      })
      .catch((error: unknown) => {
        this.heartbeat?.stop(runId);
        store.locks.releaseRunLease(runId, store.holder);
        record.settled = true;
        record.resolve({
          run_id: runId,
          status: "failed",
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
      });
    return Object.freeze({ run_id: runId, status: "started" as const });
  }

  private persistSpend(
    store: OwnershipStore,
    runId: string,
    budget: number | null,
    seeded: Readonly<{ tokensIn: number; tokensOut: number }>,
    engine: WorkflowEngine,
    ownership: Ownership,
  ): void {
    store.repository.putRunSpend(
      runId,
      budget,
      engine.budget.tokensIn,
      engine.budget.tokensOut,
      0,
      0,
      0,
      ownership,
    );
    void seeded;
  }

  private persistLine(store: OwnershipStore, runId: string, fields: Parameters<WorkflowRepository["putRunState"]>[1]): boolean {
    return store.repository.putRunState(runId, fields);
  }

  private seedSpend(store: OwnershipStore, runId: string): Readonly<{ tokensIn: number; tokensOut: number }> {
    const fromRow = store.repository.getRunSpend(runId);
    const fromCells = store.repository.cacheCostTotals(runId);
    const rowIn = Number(fromRow?.tokens_in ?? 0);
    const rowOut = Number(fromRow?.tokens_out ?? 0);
    const useRow = rowIn + rowOut >= fromCells.tokensIn + fromCells.tokensOut;
    return useRow
      ? { tokensIn: rowIn, tokensOut: rowOut }
      : { tokensIn: fromCells.tokensIn, tokensOut: fromCells.tokensOut };
  }

  private seedSpendTotal(runId: string): number {
    const store = this.store;
    if (store === undefined) return 0;
    const seeded = this.seedSpend(store, runId);
    return seeded.tokensIn + seeded.tokensOut;
  }

  private seedSpendOfRun(runId: string): number {
    return this.seedSpendTotal(runId);
  }

  private durableOf(runId: string): DurableRunView | null {
    const store = this.store;
    if (store === undefined) return null;
    const row = store.repository.getRunState(runId);
    return row === null ? null : durableFromRow(row);
  }

  // --- records -----------------------------------------------------------------

  private makeRecord(
    runId: string,
    name: string,
    engine: WorkflowEngine,
  ): RunRecord {
    let resolve!: (value: Readonly<Record<string, unknown>>) => void;
    const promise = new Promise<Readonly<Record<string, unknown>>>((res) => {
      resolve = res;
    });
    return {
      id: runId,
      name,
      engine,
      promise,
      result: null,
      resolve,
      settled: false,
    };
  }

  // --- reads: live + durable ---------------------------------------------------

  async status(
    runId: string,
    wait = false,
  ): Promise<Readonly<Record<string, unknown>> | WorkflowServiceError> {
    const record = this.runs.get(runId);
    if (record !== undefined) {
      if (wait && !record.settled) {
        const settledView = await record.promise;
        return settledView;
      }
      if (record.result !== null && record.settled) {
        return resultView(record.id, record.name, record.result, record.engine.budget);
      }
      return Object.freeze({
        run_id: record.id,
        name: record.name,
        status: "running",
        progress: record.engine.progress(),
        token_budget: record.engine.budget.snapshot(),
      });
    }
    const view = this.durableOf(runId);
    if (view === null) return Object.freeze({ error: `unknown workflow run '${runId}'` });
    const store = this.store;
    const stale =
      view.status === "running" &&
      (store === undefined || store.locks.runLeaseExpiry(runId, store.ownershipOf().now) === null);
    const spent = this.seedSpendTotal(runId);
    return Object.freeze(durableRollup(view, spent, stale));
  }

  async runAndWait(
    spec: unknown,
    args: Readonly<Record<string, unknown>> = {},
    options: {
      readonly tokenBudget?: number | null;
      readonly resumeRunId?: string;
    } = {},
  ): Promise<Readonly<Record<string, unknown>> | WorkflowServiceError> {
    const record = this.runs.get(options.resumeRunId ?? "");
    const started = this.start(spec, args, options);
    if ("error" in started) return started;
    const target = record ?? this.runs.get(started.run_id);
    if (target === undefined) {
      return (await this.status(started.run_id, false));
    }
    return target.promise;
  }

  list(): readonly Readonly<Record<string, unknown>>[] {
    const entries: Record<string, unknown>[] = [];
    for (const record of this.runs.values()) {
      const progress = record.engine.progress();
      entries.push(
        Object.freeze({
          run_id: record.id,
          name: record.name,
          status: record.settled ? (record.result?.status ?? "complete") : "running",
          nodes_done: progress.done,
          nodes_total: progress.total,
          tokens_spent: record.engine.budget.tokensSpent,
          token_budget: record.engine.budget.tokenBudget,
        }),
      );
    }
    const store = this.store;
    if (store !== undefined) {
      const now = store.ownershipOf().now;
      for (const row of store.repository.recentRunStates(50)) {
        const view = durableFromRow(row);
        if (this.runs.has(view.run_id)) continue;
        const entry: Record<string, unknown> = {
          run_id: view.run_id,
          name: view.name,
          status: view.status,
          nodes_done: Number(view.progress?.done ?? 0),
          nodes_total: Number(view.progress?.total ?? 0),
          tokens_spent: this.seedSpendOfRun(view.run_id),
          token_budget: view.token_budget,
        };
        if (view.status === "running" && store.locks.runLeaseExpiry(view.run_id, now) === null) {
          entry.stale = true;
        }
        entries.push(Object.freeze(entry));
      }
    }
    return Object.freeze(entries);
  }

  pause(runId: string): WorkflowServiceError | Readonly<Record<string, unknown>> {
    const record = this.runs.get(runId);
    if (record === undefined) return Object.freeze({ error: `unknown workflow run '${runId}'` });
    record.engine.requestPause();
    return Object.freeze({ run_id: runId, status: "paused" });
  }

  cancel(runId: string): WorkflowServiceError | Readonly<Record<string, unknown>> {
    const record = this.runs.get(runId);
    if (record !== undefined) {
      record.engine.cancel();
      return Object.freeze({ run_id: runId, status: "cancelled" });
    }
    const store = this.store;
    if (store === undefined) return Object.freeze({ error: `unknown workflow run '${runId}'` });
    // Ownerless cancel of a run only known from its line — UNLEASED condition
    // rides in the write's own statement.
    const view = this.durableOf(runId);
    if (view === null) return Object.freeze({ error: `unknown workflow run '${runId}'` });
    const expiry = store.locks.runLeaseExpiry(runId, store.ownershipOf().now);
    if (expiry !== null) {
      return Object.freeze({ error: "busy", run_id: runId });
    }
    const written = store.repository.putRunState(runId, {
      name: view.name,
      owner: view.owner,
      status: "cancelled",
      pauseReason: null,
      pausePayloadJson: null,
      specJson: view.spec === null ? null : JSON.stringify(view.spec),
      argsJson: JSON.stringify(view.args),
      tokenBudget: view.token_budget,
      tainted: view.tainted,
      progressJson: view.progress === null ? null : JSON.stringify(view.progress),
      auditSegmentId: view.audit_segment_id,
      updatedAt: store.ownershipOf().now,
      fence: null,
      holder: null,
      now: store.ownershipOf().now,
      requireUnleased: true,
    });
    if (!written) return Object.freeze({ error: "busy", run_id: runId });
    return Object.freeze({ run_id: runId, status: "cancelled" });
  }
}

function rawSpecOf(parsed: WorkflowSpec): Record<string, unknown> {
  return {
    meta: { ...parsed.meta },
    inputs: { ...parsed.inputs },
    schemas: { ...parsed.schemas },
    nodes: parsed.nodes.map((node) => ({ id: node.id, type: node.type, ...node.fields })),
  };
}

function progressJsonOf(result: RunResult): string | null {
  void result;
  return null;
}
