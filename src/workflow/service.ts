import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { Budget } from "./budget.js";
import { MemoryWorkflowCache, type WorkflowCache } from "./cache.js";
import { SqliteWorkflowCache } from "./sqlite-cache.js";
import type { WorkflowEvent, WorkflowLoader } from "./engine-contract.js";
import { WorkflowEngine } from "./engine.js";
import { AutoResumeScheduler, LeaseHeartbeat, type Timer } from "./durability.js";
import type { ChildRuntime, LeafSandboxHandle, LeafToolDispatch } from "./runtime.js";
import { validateSpec } from "./schema.js";
import { ValidationError, type WorkflowSpec } from "./types.js";
import type { RunResult } from "./accounting.js";
import type { ProgressSnapshot } from "./progress.js";
import type { Ownership } from "../state/workflow-repository.js";
import { WorkflowRepository } from "../state/workflow-repository.js";
import {
  DENY_ALL_POLICY,
  loadPolicy,
  sandboxDispatch,
  taintWrap,
  toolError,
  TaintTracker,
  type ToolDispatchLike,
  type SandboxPolicy,
} from "./sandbox.js";
import type { LockRepository } from "../state/locks.js";

export const RUN_LEASE_TTL = 900;
/** The operator capability policy, read from the operator home per launch. */
export const OPERATOR_POLICY_FILE = "workflow_policy.json";
export const FENCE_MEMORY = 1024;

/** The token an evicted run presents: never a number, so a forgotten fence can
 * never be guessed into a write. Mirrors the oracle's EVICTED sentinel. */
export const EVICTED = Symbol.for("lohra.workflow.fence.evicted");

/**
 * Bounded memory of the fence each run acquired, oldest evicted first at
 * FENCE_MEMORY entries. An evicted run has no honest token left, so its owned
 * writes are refused fail-closed rather than presented with a guess.
 */
export class FenceMemory {
  private readonly fences = new Map<string, number>();

  public constructor(private readonly capacity: number = FENCE_MEMORY) {}

  public remember(runId: string, fence: number): void {
    this.fences.delete(runId);
    this.fences.set(runId, fence);
    while (this.fences.size > Math.max(1, this.capacity)) {
      const oldest = this.fences.keys().next();
      if (oldest.done === true) break;
      this.fences.delete(oldest.value);
    }
  }

  public forget(runId: string): void {
    this.fences.delete(runId);
  }

  public tokenOf(runId: string): number | typeof EVICTED {
    const fence = this.fences.get(runId);
    return fence === undefined ? EVICTED : fence;
  }

  public get size(): number {
    return this.fences.size;
  }
}

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
  /** The shared connection, for the default fenced SQLite node cache. */
  readonly database: import("better-sqlite3").Database;
}

export interface WorkflowStartResult {
  readonly run_id: string;
  readonly status: "started";
}

export interface WorkflowServiceError {
  readonly error: string;
  readonly invalid_spec?: boolean;
  /** Nominal cause, when the refusal has one (see leafSandboxUnavailable). */
  readonly cause?: string;
  readonly run_id?: string;
}

export interface OwnershipLost {
  readonly error: "workflow ownership lost";
  readonly cause: "STALE_FENCE_WRITE";
  readonly run_id: string;
  readonly fence: number;
}

export interface LeafSandboxUnavailable {
  readonly error: "workflow leaf sandbox unavailable";
  readonly cause: "LEAF_SANDBOX_UNAVAILABLE";
  readonly run_id: string;
}

/**
 * A durable run whose runtime cannot install the leaf sandbox does not start.
 * Running leaves with the operator policy unenforced is the failure this whole
 * capability exists to prevent, so the launch fails closed BEFORE any spawn.
 */
export function leafSandboxUnavailable(runId: string): LeafSandboxUnavailable {
  return Object.freeze({
    error: "workflow leaf sandbox unavailable" as const,
    cause: "LEAF_SANDBOX_UNAVAILABLE" as const,
    run_id: runId,
  });
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
  /**
   * What this run PUBLISHES once it settles — the single terminal answer every
   * channel reads. Keeping only `result` let `status` and `list` rebuild
   * success from the engine's outcome after the terminal write had been
   * refused, so a run whose durable line still said `running` was reported
   * complete. Fail-closed means one published value, not one per channel.
   */
  published: Readonly<Record<string, unknown>> | null;
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

function defaultServiceTimer(delay: number, fire: () => void): Timer {
  const handle = setTimeout(fire, delay * 1000);
  handle.unref();
  return {
    cancel: () => {
      clearTimeout(handle);
    },
  };
}

function isLive(record: RunRecord | undefined): boolean {
  return record !== undefined && !record.settled;
}

/** What the registry-clash message names: the live entry's own status. */
function liveStatusOf(record: RunRecord | undefined): string {
  return record?.result?.status ?? "running";
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
  private readonly policyLoader: (() => SandboxPolicy) | undefined;
  private readonly taintTracker: TaintTracker;
  private readonly autoResume: AutoResumeScheduler | undefined;
  private readonly homeRoot: string;
  private readonly fenceMemory: FenceMemory;
  private readonly warn: (message: string) => void;
  /** Per-ACQUISITION sandbox context; the leaf dispatch of a stretch reads it
   * live, so a resume with a fresh policy/taint is what its leaves get. */
  private readonly stretches = new Map<
    string,
    {
      readonly stretchId: number;
      readonly workingRoot: string;
      readonly policy: SandboxPolicy;
      readonly tainted: boolean;
    }
  >();
  /** Monotonic id per ACQUISITION, so two stretches of one run never share one. */
  private stretchSeq = 0;

  public constructor(options: {
    readonly runtime: ChildRuntime;
    readonly cache?: WorkflowCache;
    readonly loader?: WorkflowLoader;
    readonly idSource?: () => string;
    readonly onEvent?: (event: WorkflowEvent) => void;
    readonly store?: OwnershipStore;
    readonly cacheFactory?: (runId: string) => WorkflowCache;
    /** Production wiring: read the operator capability policy per launch. */
    readonly policyPath?: string;
    readonly taintTracker?: TaintTracker;
    /** Operator home root: `<home>/runs/<run_id>/work-<fence>` scratch. */
    readonly homeRoot?: string;
    /** Injectable for tests; production uses a real repeating timer. */
    readonly timerFactory?: (delay: number, fire: () => void) => Timer;
    /** Bounded fence memory; only tests shrink it below FENCE_MEMORY. */
    readonly fenceMemory?: number;
    /** Where cleanup failures are recorded; defaults to console.warn. */
    readonly onWarning?: (message: string) => void;
  }) {
    this.runtime = options.runtime;
    this.cache = options.cache ?? new MemoryWorkflowCache();
    this.loader = options.loader;
    this.idSource = options.idSource ?? (() => randomUUID().replaceAll("-", ""));
    this.onEvent = options.onEvent;
    this.store = options.store;
    this.cacheFactory = options.cacheFactory;
    // Never optional: a run with no tracker could not notice a leaf tainting it.
    this.taintTracker = options.taintTracker ?? new TaintTracker();
    this.homeRoot = options.homeRoot ?? ".";
    this.fenceMemory = new FenceMemory(options.fenceMemory ?? FENCE_MEMORY);
    this.warn = options.onWarning ?? ((message) => { console.warn(message); });
    // Criterion 40: the operator capability policy is a FILE in the operator
    // home (`workflow_policy.json`), read per launch. An explicit path wins;
    // an absent file is deny-all, never a widening.
    const policyPath = options.policyPath ?? join(this.homeRoot, OPERATOR_POLICY_FILE);
    this.policyLoader = () => loadPolicy(policyPath);
    const store = options.store;
    if (store !== undefined) {
      const timerFactory = options.timerFactory ?? defaultServiceTimer;
      this.autoResume = new AutoResumeScheduler(
        (runId) => this.start(null, {}, { resumeRunId: runId }),
        { timerFactory },
      );
      // Production heartbeat: a REAL repeating timer (setTimeout) renews the
      // lease every TTL/3 while the run holds it. Tests inject their own
      // timer factory; the service default is the live clock, not a no-op.
      this.heartbeat = new LeaseHeartbeat(
        (runId) =>
          store.locks.renewRunLease(runId, store.holder, store.ownershipOf().now, store.ttl),
        { interval: store.ttl / 3, timerFactory },
      );
      // Cold start: a dead process left quota-paused lines behind; re-arm them
      // from the durable rows with the attempts they had already spent.
      this.autoResume.rearmPendingResumes(
        (pauseReason) =>
          store.repository
            .runStatesByPause(pauseReason, 50)
            .map((row) => ({ run_id: String(row.run_id) })),
        (runId) => this.durableOf(runId)?.attempts ?? 0,
      );
    }
  }

  /**
   * The leaf capability seam: whoever implements `ChildRuntime` wraps its leaf
   * tool dispatch with this, and the run's leaves get the operator policy (from
   * operator config, NEVER the spec), the per-acquisition working root and the
   * sticky taint gate. Evaluated per call, so a `web_fetch` that taints the
   * session closes fs/egress for every call after it — in the same stretch.
   */
  /**
   * The composition handed to the runtime, pinned to ONE acquisition. Once a
   * newer stretch owns the run, the older stretch's wrapper stops granting
   * anything: its working root and its taint are no longer the run's.
   */
  private stretchToolDispatch(
    runId: string,
    stretchId: number,
    base: LeafToolDispatch,
  ): LeafToolDispatch {
    const tracker = this.taintTracker;
    const marked = taintWrap(base, tracker);
    return (name, args) => {
      const stretch = this.stretches.get(runId);
      if (stretch === undefined || stretch.stretchId !== stretchId) {
        return toolError("workflow stretch is no longer current (sandbox denied)");
      }
      const tainted = stretch.tainted || tracker.tainted;
      return sandboxDispatch(marked, {
        workingRoot: stretch.workingRoot,
        policy: stretch.policy,
        tainted,
      })(name, args);
    };
  }

  public leafToolDispatch(runId: string, base: ToolDispatchLike): ToolDispatchLike {
    const tracker = this.taintTracker;
    // taint marks INSIDE the sandbox: a call the sandbox denied never taints.
    const marked = taintWrap(base, tracker);
    return (name, args) => {
      const stretch = this.stretches.get(runId);
      const policy = stretch?.policy ?? this.policyLoader?.() ?? DENY_ALL_POLICY;
      const workingRoot = stretch?.workingRoot ?? this.workingRootOf(runId, 0);
      // Taint is ORed and never downgraded: the live stretch, the durable line
      // a previous process wrote, and this session's tracker.
      const tainted =
        (stretch?.tainted ?? this.durableOf(runId)?.tainted === true) || tracker.tainted;
      return sandboxDispatch(marked, { workingRoot, policy, tainted })(name, args);
    };
  }

  /** The scratch root the run's leaves may write to, for this acquisition. */
  public workingRootFor(runId: string): string {
    return this.stretches.get(runId)?.workingRoot ?? this.workingRootOf(runId, 0);
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
    // Even without a durable store the leaves are sandboxed: operator policy,
    // a run-scoped working root, and whatever taint the session already has.
    this.stretchSeq += 1;
    this.stretches.set(runId, {
      stretchId: this.stretchSeq,
      workingRoot: this.workingRootOf(runId, 0),
      policy: this.policyLoader?.() ?? DENY_ALL_POLICY,
      tainted: this.taintTracker.tainted,
    });
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
        record.published = resultView(runId, parsed.name, result, engine.budget);
        record.resolve(record.published);
      })
      .catch(() => {
        record.settled = true;
        record.published = Object.freeze({
          run_id: runId,
          status: "failed",
          error: "workflow run failed",
        });
        record.resolve(record.published);
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
    // Taint is ORed, never downgraded: the session's tracker plus whatever the
    // durable line already carried.
    const tainted = (priorView?.tainted === true) || this.taintTracker.tainted;
    const liveHere = this.runs.get(runId);
    // Criterion 25 — the REGISTRY guard, checked before anything is acquired or
    // written. A second engine on a run that has not stopped would share this
    // one's node cache and working root, and the older stretch would go on
    // writing into a run nobody tracks. Refuse, take no lease, touch no ledger.
    if (isLive(liveHere)) {
      return Object.freeze({
        error:
          `workflow run '${runId}' has not finished (status: ${liveStatusOf(liveHere)}); ` +
          "wait for it (workflow_status) or cancel it before resuming",
      });
    }
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
      // Never sit on a lease for a run we are not going to start — and give
      // back only the one we took, conditioned on our own fence.
      this.heartbeat?.stop(runId);
      store.locks.releaseRunLeaseAtFence(runId, store.holder, fence);
      return Object.freeze({ error: refusal });
    }
    // THIS acquisition, with an identity of its own. Keying anything by run_id
    // alone let a later acquisition of the SAME run hand its fence to an older
    // stretch still finishing: the old one then wrote a terminal line with a
    // token it never held, and released a lease belonging to the live stretch.
    // A stretch presents the fence IT acquired, and only while it is still the
    // current one.
    this.stretchSeq += 1;
    const stretchId = this.stretchSeq;
    const fenceKey = `${runId}#${String(stretchId)}`;
    // Bounded fence memory: an evicted stretch has no honest token left, so its
    // owned writes are refused fail-closed instead of presenting a guess.
    this.fenceMemory.remember(fenceKey, fence);
    const isCurrentStretch = (): boolean => this.stretches.get(runId)?.stretchId === stretchId;
    const stretchOwnership = (): Ownership | null => {
      if (!isCurrentStretch()) return null;
      const token = this.fenceMemory.tokenOf(fenceKey);
      if (token === EVICTED) return null;
      return { fence: token, holder: store.holder, now: store.ownershipOf().now };
    };
    // The operator capability policy is loaded per launch from operator
    // config, never from the spec. The leaves of this stretch reach it through
    // `leafToolDispatch`, which reads this record live.
    const policy = this.policyLoader?.() ?? DENY_ALL_POLICY;
    const workingRoot = this.workingRootOf(runId, fence);
    this.stretches.set(runId, { stretchId, workingRoot, policy, tainted });
    // The leaf sandbox is INSTALLED for this acquisition before a single leaf
    // can spawn, and the run refuses to start if the runtime cannot take it.
    // The wrapper is pinned to this stretch: once a newer acquisition exists,
    // this one's wrapper denies everything rather than serving stale capability.
    const install = this.runtime.installLeafSandbox?.bind(this.runtime);
    // A launch that dies between taking the lease and handing the run over must
    // give BOTH back: a lease nobody will renew locks every later resume out
    // until the TTL runs down, and a heartbeat with no run behind it keeps
    // renewing it. An installer that THROWS is the same failure as one that is
    // missing, so both land here.
    const abandonAcquisition = (): void => {
      this.heartbeat?.stop(runId);
      this.stretches.delete(runId);
      store.locks.releaseRunLeaseAtFence(runId, store.holder, fence);
      this.fenceMemory.forget(fenceKey);
    };
    if (install === undefined) {
      abandonAcquisition();
      return leafSandboxUnavailable(runId);
    }
    let sandboxHandle: LeafSandboxHandle;
    try {
      sandboxHandle = install({
        runId,
        fence,
        wrap: (base: LeafToolDispatch): LeafToolDispatch =>
          this.stretchToolDispatch(runId, stretchId, base),
      });
    } catch (error) {
      abandonAcquisition();
      this.warn(
        `workflow: leaf sandbox install failed for run ${runId}: ${String(error)}`,
      );
      return leafSandboxUnavailable(runId);
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
      // Durable default: the FENCED SQLite node cache over the shared
      // connection. An explicit cache/cacheFactory still wins.
      ...(this.cacheFactory !== undefined
        ? { cache: this.cacheFactory(runId) }
        : this.cache instanceof MemoryWorkflowCache
          ? {
              cache: new SqliteWorkflowCache(
                store.database,
                runId,
                () => stretchOwnership() ?? { fence: -1, holder: store.holder, now: store.ownershipOf().now },
                {
                  repository: store.repository,
                  // Cheap top-up (criterion 39): each cell that lands renews the
                  // lease, so one long node cannot let it lapse between beats.
                  // The heartbeat stays the guarantor; this is not a substitute.
                  onWrite: () => {
                    if (!isCurrentStretch()) return;
                    store.locks.renewRunLease(
                      runId,
                      store.holder,
                      store.ownershipOf().now,
                      store.ttl,
                    );
                  },
                },
              ),
            }
          : { cache: this.cache }),
    });
    const record = this.makeRecord(runId, parsed.name, engine);
    /**
     * Hand this acquisition back: exactly once, and never by throwing.
     *
     * Every step is independent — a step that fails must not skip the ones
     * after it, and none of them may stop the run from publishing a bounded
     * result. A disposer that threw used to escape the success path, land in
     * `.catch`, be called a second time, throw again, and leave the waiter
     * hanging on a promise chain that rejected with nobody listening.
     *
     * The heartbeat stops FIRST: a tick that outlived the release would put the
     * lease back and leave the run looking alive with nobody in it. The release
     * itself is conditioned on this acquisition's fence INSIDE its own
     * statement, so a takeover by the same holder cannot be deleted by it.
     */
    let finished = false;
    const finishStretch = (): void => {
      if (finished) return;
      finished = true;
      const step = (what: string, run: () => void): void => {
        try {
          run();
        } catch (error) {
          this.warn(`workflow: ${what} failed for run ${runId}: ${String(error)}`);
        }
      };
      step("heartbeat stop", () => {
        if (isCurrentStretch()) this.heartbeat?.stop(runId);
      });
      step("stretch deregistration", () => {
        if (isCurrentStretch()) this.stretches.delete(runId);
      });
      step("lease release", () => {
        store.locks.releaseRunLeaseAtFence(runId, store.holder, fence);
      });
      step("fence memory release", () => { this.fenceMemory.forget(fenceKey); });
      // only THIS acquisition's installation
      step("leaf sandbox disposal", () => { sandboxHandle.dispose(); });
    };
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
    this.persistSpend(store, runId, effectiveBudget, seeded, engine, stretchOwnership());
    void engine
      .run(parsed, args)
      .then((result) => {
        record.result = result;
        const faults = [...priorFaults, ...result.faults];
        const degraded =
          priorDegraded ||
          result.faults.some((fault) => fault !== result.pauseFault);
        const terminal = stretchOwnership();
        // Taint acquired INSIDE this stretch counts: a leaf that ran an allowed
        // web_fetch marked the tracker, and the line this stretch writes must
        // carry that, not the value read before the engine started.
        const taintedNow = tainted || this.taintTracker.tainted;
        const owned = terminal === null ? false : this.persistLine(store, runId, {
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
          tainted: taintedNow,
          progressJson: progressJsonOf(engine.progress()),
          auditSegmentId: null,
          updatedAt: terminal.now,
          fence: terminal.fence,
          holder: terminal.holder,
          now: terminal.now,
        });
        this.persistSpend(store, runId, effectiveBudget, seeded, engine, stretchOwnership());
        // A quota pause is the one failure that fixes itself given time: arm
        // the retry here (bounded, capped); token-budget and checkpoint pauses
        // arm nothing — waiting does not refill a budget, only an ANSWER moves
        // a checkpoint.
        let resumeAt: number | null = null;
        if (owned && result.status === "paused" && result.pauseReason === QUOTA_PAUSE) {
          const retryAfter =
            result.checkpoint !== null &&
            typeof (result.checkpoint as Record<string, unknown>).retry_after === "number"
              ? ((result.checkpoint as Record<string, unknown>).retry_after as number)
              : null;
          resumeAt =
            this.autoResume?.schedule(runId, {
              attempts: (priorView?.attempts ?? 0) + 1,
              retryAfter,
            }) ?? null;
        }
        if (resumeAt !== null && terminal !== null) {
          this.persistLine(store, runId, {
            name: parsed.name,
            owner: store.holder,
            status: "paused",
            pauseReason: QUOTA_PAUSE,
            pausePayloadJson: JSON.stringify({
              checkpoint: null,
              resume_at: resumeAt,
              attempts: (priorView?.attempts ?? 0) + 1,
              prior_faults: faults,
              prior_degraded: degraded,
            }),
            specJson: JSON.stringify(rawSpecOf(parsed)),
            argsJson: JSON.stringify(args),
            tokenBudget: effectiveBudget,
            tainted: taintedNow,
            progressJson: progressJsonOf(engine.progress()),
            auditSegmentId: null,
            updatedAt: terminal.now,
            fence: terminal.fence,
            holder: terminal.holder,
            now: terminal.now,
          });
        }
        finishStretch();
        record.settled = true;
        if (owned) {
          record.published = resultView(runId, parsed.name, result, engine.budget);
          record.resolve(record.published);
        } else {
          // Fail-closed (errata E2): a stretch that lost ownership never
          // publishes a terminal success — no done, no notify, no publish; the
          // waiter resolves BOUNDED with the errata envelope instead.
          record.published = ownershipLost(runId, fence) as unknown as Readonly<
            Record<string, unknown>
          >;
          record.resolve(record.published);
        }
      })
      .catch((error: unknown) => {
        finishStretch();
        record.settled = true;
        record.published = Object.freeze({
          run_id: runId,
          status: "failed",
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
        record.resolve(record.published);
      });
    return Object.freeze({ run_id: runId, status: "started" as const });
  }

  private persistSpend(
    store: OwnershipStore,
    runId: string,
    budget: number | null,
    seeded: Readonly<{ tokensIn: number; tokensOut: number }>,
    engine: WorkflowEngine,
    ownership: Ownership | null,
  ): void {
    // Evicted from the bounded fence memory: no honest token to present, so
    // the ledger write is refused here rather than guessed into SQL.
    if (ownership === null) return;
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

  /** One scratch directory per ACQUISITION, named by the fence, so a stale
   * owner's leaves write harmlessly into their own obsolete root. */
  private workingRootOf(runId: string, fence: number): string {
    return join(this.homeRoot, "runs", runId, `work-${String(fence)}`);
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
      published: null,
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
      if (record.settled && record.published !== null) return record.published;
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
    // Take the record AFTER `start`: capturing it before meant a resume waited
    // on the PREVIOUS stretch's promise, which had already settled `paused`,
    // while the new stretch went on to complete the run.
    const started = this.start(spec, args, options);
    if ("error" in started) return started;
    const target = this.runs.get(started.run_id);
    if (target === undefined) {
      return (await this.status(started.run_id, false));
    }
    return target.promise;
  }

  list(): readonly Readonly<Record<string, unknown>>[] {
    const entries: Record<string, unknown>[] = [];
    for (const record of this.runs.values()) {
      const progress = record.engine.progress();
      // A settled run reports what it PUBLISHED. A stretch that lost ownership
      // published an error envelope, and `list` must say so rather than read
      // the engine's own (successful) outcome behind it.
      const publishedStatus =
        record.published !== null && typeof record.published.status === "string"
          ? record.published.status
          : record.published !== null
            ? "ownership_lost"
            : (record.result?.status ?? "complete");
      entries.push(
        Object.freeze({
          run_id: record.id,
          name: record.name,
          status: record.settled ? publishedStatus : "running",
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
    // The BUSY decision rides in the write's own statement (requireUnleased):
    // no read-before-write window in which an owner could acquire.
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

/** The oracle's None-when-empty rule: a run with no nodes persists no progress. */
function progressJsonOf(progress: ProgressSnapshot): string | null {
  return progress.total > 0 ? JSON.stringify(progress) : null;
}
