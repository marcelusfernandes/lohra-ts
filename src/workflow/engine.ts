import { randomUUID } from "node:crypto";

import { usage } from "../pricing/usage.js";
import type { Usage } from "../pricing/types.js";
import { addUsageToResult, deriveStatus, RunResult } from "./accounting.js";
import { Budget, FanoutRejected, TokenBudgetExhausted } from "./budget.js";
import { contentHash, MemoryWorkflowCache, type WorkflowCache } from "./cache.js";
import { DEFAULT_LEAF_MAX_ITERATIONS, EMPTY_OUTPUT_CORRECTION, GATE_VERDICT_SCHEMA, JUDGE_SCORE_SCHEMA, LEAF_TIMEOUT_SECONDS, MAX_WORKFLOW_DEPTH, PIPELINE_TIMEOUT_SECONDS, type LeafExecution, type RunControl, type Strategy, type WorkflowEngineOptions, type WorkflowEvent, type WorkflowLoader, VERIFY_SCHEMA } from "./engine-contract.js";
import { asRecord, clampInteger, combine, nonEmpty, renderValue, resultUsage, routingIdentity, routingOf, strictResolve, verifyPrompt } from "./engine-utils.js";
import { topologicalOrder } from "./graph.js";
import { MAX_GATE_ATTEMPTS, MAX_NODE_MAX_ITERATIONS, MAX_NODE_RETRIES } from "./nodes.js";
import { correctionPrompt, isEmptyOutput, MAX_VALIDATION_RETRIES, parseAndValidate } from "./output-validation.js";
import { ProgressTracker, type ProgressSnapshot } from "./progress.js";
import { BoundedPool } from "./pool.js";
import type { CausalContext, ChildResult, ChildRuntime } from "./runtime.js";
import { validateSpec } from "./schema.js";
import type { TierMap } from "./tiers.js";
import { Node, ValidationError, type WorkflowSpec } from "./types.js";
export class WorkflowEngine {
  readonly budget: Budget;
  readonly runId: string;
  readonly segmentId: string;
  readonly depth: number;
  private readonly runtime: ChildRuntime;
  private readonly pool: BoundedPool;
  private readonly control: RunControl;
  private readonly cache: WorkflowCache;
  private readonly loader: WorkflowLoader | undefined;
  private readonly onEvent: ((event: WorkflowEvent) => void) | undefined;
  private readonly logError: (...args: unknown[]) => void;
  private readonly checkpointAnswers: Readonly<Record<string, unknown>>;
  private readonly nodeScope: readonly string[];
  private readonly pipelineTimeoutSeconds: number;
  private readonly tiers: TierMap;
  private readonly strategies = new Map<string, Strategy>();
  private readonly progressTracker = new ProgressTracker();
  private result = new RunResult();
  private schemas: Readonly<Record<string, unknown>> = {};
  private currentNode = "?";
  private specIdentity: readonly unknown[] = ["workflow", null];
  private readonly activeLeaves = new Set<string>();
  private eventSinkDisabled = false;
  private accounted = new Set<string>();
  private leafCosts = new Map<string, Usage>();

  constructor(options: WorkflowEngineOptions) {
    this.runtime = options.runtime;
    this.budget = options.budget ?? new Budget();
    this.pool = options.pool ?? new BoundedPool(this.budget.poolWidth);
    this.control = options.control ?? { cancelled: false, paused: false, pauseReason: null, pausePayload: null };
    this.cache = options.cache ?? new MemoryWorkflowCache();
    this.loader = options.loader;
    this.runId = options.runId ?? randomUUID().replaceAll("-", "");
    this.segmentId = options.segmentId ?? randomUUID().replaceAll("-", "");
    this.depth = options.depth ?? 0;
    this.nodeScope = Object.freeze([...(options.nodeScope ?? [])]);
    this.checkpointAnswers = Object.freeze({ ...(options.checkpointAnswers ?? {}) });
    this.pipelineTimeoutSeconds = options.pipelineTimeoutSeconds ?? PIPELINE_TIMEOUT_SECONDS;
    this.tiers = options.tiers ?? {};
    this.onEvent = options.onEvent;
    this.logError = options.logError ?? console.error;
    this.installStrategies();
  }

  private installStrategies(): void {
    this.strategies.set("agent", (engine, node, context) => engine.runAgent(node, context));
    this.strategies.set("parallel", (engine, node, context) => engine.runParallel(node, context));
    this.strategies.set("pipeline", (engine, node, context) => engine.runPipeline(node, context));
    this.strategies.set("verify", (engine, node, context) => engine.runVerify(node, context));
    this.strategies.set("judge_panel", (engine, node, context) => engine.runJudgePanel(node, context));
    this.strategies.set("loop_until_dry", (engine, node, context) => engine.runLoop(node, context));
    this.strategies.set("workflow", (engine, node, context) => engine.runNested(node, context));
    this.strategies.set("gate", (engine, node, context) => engine.runGate(node, context));
    this.strategies.set("completeness_check", (engine, node, context) => engine.runCompleteness(node, context));
    this.strategies.set("checkpoint", (engine, node, context) => Promise.resolve(engine.runCheckpoint(node, context)));
  }

  /** Deliberate test seam for proving engine-fault isolation. */
  setStrategyForTest(type: string, strategy: Strategy): void {
    this.strategies.set(type, strategy);
  }

  progress(): ProgressSnapshot {
    return this.progressTracker.snapshot();
  }

  cancel(): void {
    this.control.cancelled = true;
  }

  requestPause(): void {
    this.pause("user_requested", "run paused at the operator's request");
  }

  private emit(event: WorkflowEvent): void {
    if (this.eventSinkDisabled) return;
    try {
      this.onEvent?.(Object.freeze({ ...event }));
    } catch (error) {
      this.eventSinkDisabled = true;
      this.logError("workflow: live event failed", error);
    }
  }

  recordFault(message: string): void {
    this.result.faults.push(message);
    this.emit({ kind: "fault", nodeId: this.currentNode, text: message });
  }

  private pause(reason: string, message: string, payload: Readonly<Record<string, unknown>> | null = null): void {
    if (this.control.paused) return;
    this.control.paused = true;
    this.control.pauseReason = reason;
    this.control.pausePayload = payload;
    this.result.pauseFault = message;
    this.recordFault(message);
  }

  private gateTokens(): void {
    if (!this.budget.tokensExhausted) return;
    const message = `token budget exhausted: spent ${String(this.budget.tokensSpent)} of ${String(this.budget.tokenBudget)} tokens`;
    this.pause("token_budget", message);
    throw new TokenBudgetExhausted(message);
  }

  private gateFanout(width: number): void {
    this.budget.checkFanout(width);
    const affordable = this.budget.affordableLeaves();
    if (affordable === null || width <= affordable) return;
    const message = `${this.currentNode}: fan-out of ${String(width)} exceeds affordable leaves ${String(affordable)} — token budget exhausted`;
    this.pause("token_budget", message);
    throw new TokenBudgetExhausted(message);
  }

  private causal(role: string, cellId: string, extra: { itemIndex?: number; stageIndex?: number; attempt?: number } = {}): CausalContext {
    return Object.freeze({
      runId: this.runId,
      segmentId: this.segmentId,
      nodePath: Object.freeze([...this.nodeScope, this.currentNode]),
      cellId,
      role,
      attempt: extra.attempt ?? 0,
      turn: 0,
      ...(extra.itemIndex === undefined ? {} : { itemIndex: extra.itemIndex }),
      ...(extra.stageIndex === undefined ? {} : { stageIndex: extra.stageIndex }),
    });
  }

  private async collectLeaf(
    node: Node,
    prompt: string,
    schema: Readonly<Record<string, unknown>> | null,
    options: { readonly role: string; readonly cellId: string; readonly itemIndex?: number; readonly stageIndex?: number; readonly attempt?: number; readonly aborted?: () => boolean } ,
  ): Promise<LeafExecution> {
    const release = await this.pool.acquire();
    let id: string | null = null;
    try {
      if (options.aborted?.() === true || this.control.cancelled || this.control.paused)
        return { output: null, usage: usage(), complete: false };
      this.gateTokens();
      this.budget.checkFanout(1);
      const routing = routingOf(node, this.tiers);
      const maxIterations = Object.hasOwn(node.fields, "max_iterations")
        ? Math.min(Number(node.fields.max_iterations), MAX_NODE_MAX_ITERATIONS)
        : DEFAULT_LEAF_MAX_ITERATIONS;
      const forced = schema !== null && node.fields.tool_less === true;
      const request = {
        prompt,
        causalContext: this.causal(options.role, options.cellId, options),
        ...routing,
        maxIterations,
        ...(forced ? { forcedTool: Object.freeze({ name: "StructuredOutput", schema }) } : {}),
      };
      id = await this.runtime.spawn(request);
      this.activeLeaves.add(id);
      this.budget.charge();
      const timeout = typeof node.fields.timeout === "number" ? node.fields.timeout : LEAF_TIMEOUT_SECONDS;
      let collected = await this.runtime.collect(id, { wait: true, timeoutSeconds: timeout });
      if (collected.status === "running") {
        await this.runtime.cancel(id);
        this.recordFault(`${node.id}: leaf timeout after ${String(Math.trunc(timeout))}s (cancelled)`);
        return { output: null, usage: usage(), complete: false };
      }
      let total = resultUsage(collected);
      if (collected.status !== "complete") {
        this.account(node.id, id, collected);
        const kind = collected.errorKind === null || collected.errorKind === undefined
          ? ""
          : ` (${collected.errorKind})`;
        this.recordFault(`${node.id}: leaf ${collected.status}${kind}: ${renderValue(collected.output ?? "no detail").slice(0, 200)}`);
        return { output: null, usage: total, complete: false };
      }
      let output = collected.output;
      let usedFallback = false;
      if (forced) {
        const call = collected.toolCalls
          ?.map(asRecord)
          .find((candidate) => candidate?.name === "StructuredOutput");
        if (call !== undefined && call !== null) output = call.arguments ?? call.args ?? null;
        else usedFallback = true;
      }
      if (schema !== null && output !== null) {
      for (let attempt = 0; attempt <= MAX_VALIDATION_RETRIES; attempt += 1) {
        const parsed = parseAndValidate(output, schema);
        if (parsed.ok) {
          output = parsed.value;
          break;
        }
        if (attempt === MAX_VALIDATION_RETRIES) {
          this.account(node.id, id, { ...collected, usage: total });
          this.recordFault(`${node.id}: schema not satisfied after retries: ${parsed.error}`);
          return { output: null, usage: total, complete: false };
        }
        this.result.validationRetries += 1;
        await this.runtime.steer(id, correctionPrompt(schema, parsed.error), this.causal(options.role, options.cellId, { ...options, attempt: attempt + 1 }));
        collected = await this.runtime.collect(id, { wait: true, timeoutSeconds: timeout });
        // collect() reports the sub-session's aggregate usage; only the terminal
        // snapshot is charged, so steer turns are never double-counted.
        total = resultUsage(collected);
        if (collected.status !== "complete") {
          this.account(node.id, id, { ...collected, usage: total });
          this.recordFault(`${node.id}: leaf ${collected.status}: ${renderValue(collected.output ?? "no detail").slice(0, 200)}`);
          return { output: null, usage: total, complete: false };
        }
        output = collected.output;
      }
      }
      if (usedFallback || collected.forcedFallback === true) this.result.forcingFallbacks += 1;
      this.account(node.id, id, { ...collected, usage: total });
      return { output, usage: total, complete: true };
    } finally {
      if (id !== null) this.activeLeaves.delete(id);
      release();
    }
  }

  private account(nodeId: string, id: string, collected: ChildResult): void {
    if (this.accounted.has(id)) return;
    this.accounted.add(id);
    const next = resultUsage(collected);
    this.leafCosts.set(id, next);
    addUsageToResult(this.result, nodeId, next, collected.provider ?? null, collected.model ?? null);
    this.budget.chargeTokens(next.inputTokens, next.outputTokens);
  }

  private schemaOf(node: Node | Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | null {
    const fields = node instanceof Node ? node.fields : node;
    const inline = asRecord(fields.schema);
    if (inline !== null) return inline;
    const reference = fields.schema_ref;
    return typeof reference === "string" ? asRecord(this.schemas[reference]) : null;
  }

  private cell(parts: readonly unknown[]): string {
    return contentHash(...this.specIdentity, ...parts);
  }

  private cacheGet(hash: string): unknown {
    const found = this.cache.get(this.runId, hash);
    if (!found.hit) return CACHE_MISS;
    if (found.cost !== null) addUsageToResult(this.result, this.currentNode, found.cost, null, null);
    return found.output;
  }

  private cachePut(hash: string, nodeId: string, output: unknown, cost: Usage): void {
    if (!nonEmpty(output)) return;
    this.cache.put(this.runId, hash, nodeId, output, cost);
  }

  async run(spec: WorkflowSpec, args: Readonly<Record<string, unknown>> = {}): Promise<RunResult> {
    this.result = new RunResult();
    this.accounted = new Set();
    this.leafCosts = new Map();
    this.schemas = spec.schemas;
    this.specIdentity = Object.freeze([spec.name, spec.meta.version ?? null]);
    const ordered = topologicalOrder(spec);
    this.result.nodesTotal = ordered.length;
    this.progressTracker.reset(ordered.map((node) => node.id));
    for (const node of ordered) {
      if (this.control.cancelled || this.control.paused) break;
      this.currentNode = node.id;
      this.progressTracker.markRunning(node.id);
      this.emit({ kind: "node", nodeId: node.id, state: "running" });
      const context = Object.freeze({ args: Object.freeze({ ...args }), ...this.result.outputs });
      let output: unknown = null;
      try {
        const strategy = this.strategies.get(node.type);
        if (strategy === undefined) throw new Error(`unsupported node type ${node.type}`);
        output = await strategy(this, node, context);
      } catch (error) {
        if (error instanceof TokenBudgetExhausted) {
          output = null;
        } else if (error instanceof FanoutRejected) {
          this.recordFault(`${node.id}: ${error.message}`);
          this.result.capTrips += 1;
        } else {
          const cause = error instanceof Error ? `${error.name}: ${error.message}` : renderValue(error);
          this.recordFault(`${node.id}: engine fault: ${cause}`);
          this.result.engineFaults += 1;
          this.logError(`workflow: engine fault at node ${node.id}`, error);
        }
      }
      this.result.outputs[node.id] = output;
      this.progressTracker.settle(node.id, output);
      this.emit({ kind: "node", nodeId: node.id, state: output === null ? "null" : "complete" });
      if (output === null) this.result.nullCount += 1;
    }
    if (this.control.cancelled) this.result.status = "cancelled";
    else if (this.control.paused) {
      this.result.status = "paused";
      this.result.pauseReason = this.control.pauseReason;
      this.result.checkpoint = this.control.pausePayload;
    } else this.result.status = deriveStatus(this.result);
    return this.result;
  }

  private async runAgent(node: Node, context: Readonly<Record<string, unknown>>): Promise<unknown> {
    const prompt = strictResolve(node.fields.prompt, context);
    if (prompt === null) {
      this.recordFault(`${node.id}: upstream null`);
      return null;
    }
    const schema = this.schemaOf(node);
    const parts: unknown[] = [
      node.id,
      "agent",
      renderValue(prompt),
      schema,
      ...routingIdentity(node, this.tiers),
      node.fields.timeout ?? null,
      node.fields.retries ?? null,
    ];
    if (Object.hasOwn(node.fields, "max_iterations")) parts.push(node.fields.max_iterations);
    const hash = this.cell(parts);
    const cached = this.cacheGet(hash);
    if (cached !== CACHE_MISS) return cached;
    const retries = clampInteger(node.fields.retries, 1, MAX_NODE_RETRIES);
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const attemptPrompt =
        attempt === 0
          ? renderValue(prompt)
          : `${renderValue(prompt)}\n\n${EMPTY_OUTPUT_CORRECTION}`;
      const leaf = await this.collectLeaf(node, attemptPrompt, schema, {
        role: "agent",
        cellId: hash,
        attempt,
      });
      if (leaf.output === null) return null;
      if (!isEmptyOutput(leaf.output)) {
        this.cachePut(hash, node.id, leaf.output, leaf.usage);
        return leaf.output;
      }
    }
    this.recordFault(`${node.id}: empty output after retry`);
    return null;
  }

  private async runParallel(node: Node, context: Readonly<Record<string, unknown>>): Promise<unknown> {
    const resolved = strictResolve(node.fields.branches, context);
    if (!Array.isArray(resolved)) return null;
    const hash = this.cell([node.id, "parallel", resolved, ...routingIdentity(node, this.tiers)]);
    const cached = this.cacheGet(hash);
    if (cached !== CACHE_MISS) return cached;
    this.gateFanout(resolved.length);
    const leaves = await Promise.all(
      resolved.map((prompt, index) =>
        this.collectLeaf(node, renderValue(prompt), null, {
          role: "parallel.branch",
          cellId: hash,
          itemIndex: index,
        }),
      ),
    );
    const outputs = leaves.map((leaf) => leaf.output);
    const total = leaves.reduce((sum, leaf) => combine(sum, leaf.usage), usage());
    if (outputs.every(nonEmpty)) this.cachePut(hash, node.id, outputs, total);
    return outputs;
  }

  private async runPipeline(node: Node, context: Readonly<Record<string, unknown>>): Promise<unknown> {
    const items = strictResolve(node.fields.items, context);
    const stages: readonly unknown[] = Array.isArray(node.fields.stages)
      ? (node.fields.stages as readonly unknown[])
      : [];
    if (!Array.isArray(items)) return null;
    const itemValues = items as readonly unknown[];
    if (itemValues.length > 0) this.budget.checkFanout(itemValues.length);
    this.progressTracker.noteItems(node.id, 0, items.length);
    this.emit({ kind: "items", nodeId: node.id, done: 0, total: items.length });
    let done = 0;
    let expired = false;
    const outputs: unknown[] = Array.from({ length: itemValues.length }, () => null);
    const work = Promise.all(
      itemValues.map(async (item, itemIndex) => {
        let previous: unknown = item;
        for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {
          if (expired) return null;
          const stage = asRecord(stages[stageIndex]);
          if (stage === null) return null;
          const stageContext = Object.freeze({ ...context, item, stage: Object.freeze({ result: previous }) });
          const prompt = strictResolve(stage.prompt, stageContext);
          if (prompt === null) return null;
          const schema = this.schemaOf(stage);
          const stageNode = new Node(node.id, node.type, { ...node.fields, ...stage });
          const parts: unknown[] = [
            node.id,
            stageIndex,
            itemIndex,
            item,
            renderValue(prompt),
            schema,
            ...routingIdentity(stageNode, this.tiers),
          ];
          if (Object.hasOwn(stage, "max_iterations")) parts.push(stage.max_iterations);
          const hash = this.cell(parts);
          const cached = this.cacheGet(hash);
          if (cached !== CACHE_MISS) {
            previous = cached;
            continue;
          }
          const retries = clampInteger(stage.retries, 2, MAX_NODE_RETRIES);
          let total = usage();
          let settled: unknown = null;
          let winningCost = usage();
          let correction = "";
          for (let attempt = 0; attempt <= retries; attempt += 1) {
            const leaf = await this.collectLeaf(
              stageNode,
              correction === ""
                ? renderValue(prompt)
                : `${renderValue(prompt)}\n\n${correction}`,
              null,
              {
              role: "pipeline.stage",
              cellId: hash,
              itemIndex,
              stageIndex,
              attempt,
              aborted: () => expired,
              },
            );
            total = combine(total, leaf.usage);
            winningCost = leaf.usage;
            settled = leaf.output;
            if (settled === null) break;
            if (isEmptyOutput(settled)) {
              correction = EMPTY_OUTPUT_CORRECTION;
              continue;
            }
            if (schema !== null) {
              const parsed = parseAndValidate(settled, schema);
              if (!parsed.ok) {
                if (attempt < retries) {
                  this.result.validationRetries += 1;
                  correction = correctionPrompt(schema, parsed.error);
                  continue;
                }
                this.recordFault(`${node.id}: schema not satisfied after retries: ${parsed.error}`);
                settled = null;
                break;
              }
              settled = parsed.value;
            }
            break;
          }
          if (!nonEmpty(settled)) {
            if (isEmptyOutput(settled)) this.recordFault(`${node.id}: empty output after retry`);
            return null;
          }
          this.cachePut(hash, node.id, settled, winningCost);
          previous = settled;
        }
        done += 1;
        this.progressTracker.noteItems(node.id, done, items.length);
        this.emit({ kind: "items", nodeId: node.id, done, total: items.length });
        outputs[itemIndex] = previous;
        return previous;
      }),
    );
    let resolveDeadline: (value: "timeout") => void = () => undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      resolveDeadline = resolve;
    });
    const timer = setTimeout(() => {
      resolveDeadline("timeout");
    }, this.pipelineTimeoutSeconds * 1000);
    const outcome = await Promise.race([work.then(() => "complete" as const), deadline]);
    clearTimeout(timer);
    if (outcome === "complete") return outputs;
    expired = true;
    const active = [...this.activeLeaves];
    await Promise.allSettled(active.map((id) => Promise.resolve(this.runtime.cancel(id))));
    this.recordFault(
      `${node.id}: pipeline timeout after ${String(this.pipelineTimeoutSeconds)}s; cancelled ${String(active.length)} active leaf/leaves`,
    );
    void work.catch((error: unknown) => {
      this.logError(`workflow: late pipeline failure at node ${node.id}`, error);
    });
    return outputs;
  }

  private async runVerify(node: Node, context: Readonly<Record<string, unknown>>): Promise<unknown> {
    const finding = strictResolve(node.fields.finding, context);
    if (finding === null) return null;
    const skeptics = Math.max(1, Math.trunc(Number(node.fields.skeptics ?? 1)));
    const lenses = Array.isArray(node.fields.lenses) ? node.fields.lenses : [];
    const hash = this.cell([node.id, "verify", finding, skeptics, lenses, node.fields.kill_if_majority_refute ?? false, ...routingIdentity(node, this.tiers)]);
    const cached = this.cacheGet(hash);
    if (cached !== CACHE_MISS) return cached;
    this.gateFanout(skeptics);
    const leaves = await Promise.all(
      Array.from({ length: skeptics }, (_, index) => {
        const lens: unknown = lenses[index % Math.max(1, lenses.length)] ?? "general correctness";
        return this.collectLeaf(node, verifyPrompt(finding, lens), VERIFY_SCHEMA, {
          role: "verify.skeptic",
          cellId: hash,
          itemIndex: index,
        });
      }),
    );
    const verdicts = leaves.map((leaf) => asRecord(leaf.output));
    const counted = verdicts.filter((verdict) => verdict !== null);
    const refuted = counted.filter((verdict) => verdict.refuted === true).length;
    const kill = node.fields.kill_if_majority_refute === true;
    const survived = counted.length > 0 && !(kill && refuted * 2 > counted.length);
    if (counted.length === 0)
      this.recordFault(`verify ${node.id}: all skeptics dead (fail-closed)`);
    const result = Object.freeze({
      finding: survived ? finding : null,
      survived,
      refuted,
      skeptics: counted.length,
      verdicts,
    });
    if (counted.length === skeptics)
      this.cachePut(
        hash,
        node.id,
        result,
        leaves.reduce((sum, leaf) => combine(sum, leaf.usage), usage()),
      );
    return result;
  }

  private async runJudgePanel(node: Node, context: Readonly<Record<string, unknown>>): Promise<unknown> {
    const attempts = strictResolve(node.fields.attempts, context);
    if (!Array.isArray(attempts)) return null;
    const judges = Math.max(1, Math.trunc(Number(node.fields.judges ?? 1)));
    const synth = asRecord(node.fields.synthesize);
    this.budget.checkFanout(
      attempts.length + attempts.length * judges + (synth === null ? 0 : 1),
    );
    const hash = this.cell([node.id, "judge_panel", attempts, judges, synth, ...routingIdentity(node, this.tiers)]);
    const cached = this.cacheGet(hash);
    if (cached !== CACHE_MISS) return cached;
    this.gateFanout(attempts.length);
    const attemptLeaves = await Promise.all(
      attempts.map((prompt, index) =>
        this.collectLeaf(node, renderValue(prompt), null, {
          role: "judge.attempt",
          cellId: hash,
          itemIndex: index,
        }),
      ),
    );
    const scored: { attempt: unknown; score: number; whole: boolean }[] = [];
    let total = usage();
    let whole = true;
    total = attemptLeaves.reduce((sum, leaf) => combine(sum, leaf.usage), total);
    for (const attempt of attemptLeaves) {
      if (attempt.output === null) {
        whole = false;
        continue;
      }
      let reviews: LeafExecution[];
      try {
        this.gateFanout(judges);
        reviews = await Promise.all(
          Array.from({ length: judges }, (_, judgeIndex) =>
            this.collectLeaf(node, `Score: ${renderValue(attempt.output)}`, JUDGE_SCORE_SCHEMA, {
              role: "judge.review",
              cellId: hash,
              itemIndex: judgeIndex,
            }),
          ),
        );
      } catch (error) {
        if (error instanceof TokenBudgetExhausted) {
          whole = false;
          break;
        }
        throw error;
      }
      total = reviews.reduce((sum, review) => combine(sum, review.usage), total);
      const scores = reviews.map((review) => Number(asRecord(review.output)?.score)).filter(Number.isFinite);
      if (scores.length > 0)
        scored.push({
          attempt: attempt.output,
          score: scores.reduce((a, b) => a + b, 0) / scores.length,
          whole: scores.length === judges,
        });
      else {
        whole = false;
        this.recordFault(`judge_panel ${node.id}: attempt unscored (all judges dead)`);
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const winner = scored[0]?.attempt ?? null;
    if (winner === null) return null;
    if (synth === null) {
      if (whole && scored.every((entry) => entry.whole)) this.cachePut(hash, node.id, winner, total);
      return winner;
    }
    const prompt = strictResolve(synth.prompt, Object.freeze({ ...context, winner }));
    let synthesis: LeafExecution;
    try {
      synthesis = await this.collectLeaf(node, `${renderValue(prompt)}\n\nWINNER:\n${renderValue(winner)}`, this.schemaOf(synth), {
        role: "judge.synthesis",
        cellId: hash,
      });
    } catch (error) {
      if (error instanceof TokenBudgetExhausted) return winner;
      throw error;
    }
    total = combine(total, synthesis.usage);
    if (synthesis.output === null) return null;
    if (whole && scored.every((entry) => entry.whole))
      this.cachePut(hash, node.id, synthesis.output, total);
    return synthesis.output;
  }

  private async runLoop(node: Node, context: Readonly<Record<string, unknown>>): Promise<unknown> {
    const body = asRecord(node.fields.body);
    if (body === null) return null;
    const stopAfter = Math.max(1, Math.trunc(Number(node.fields.stop_after_k_empty ?? 1)));
    const rounds = Math.max(1, Math.trunc(Number(node.fields.max_rounds ?? 1)));
    const firstPrompt = strictResolve(body.prompt, Object.freeze({ ...context, round: 0, so_far: [] }));
    if (firstPrompt === null) return null;
    const bodySchema = this.schemaOf(body);
    const hash = this.cell([node.id, "loop_until_dry", firstPrompt, bodySchema, stopAfter, rounds, ...routingIdentity(node, this.tiers)]);
    const cached = this.cacheGet(hash);
    if (cached !== CACHE_MISS) return cached;
    const collected: unknown[] = [];
    let empty = 0;
    let intact = true;
    let total = usage();
    for (let round = 0; round < rounds && empty < stopAfter; round += 1) {
      const prompt = strictResolve(body.prompt, Object.freeze({ ...context, round, so_far: Object.freeze([...collected]) }));
      if (prompt === null) return null;
      let leaf: LeafExecution;
      try {
        leaf = await this.collectLeaf(node, renderValue(prompt), bodySchema, {
          role: "loop.round",
          cellId: hash,
          attempt: round,
        });
      } catch (error) {
        if (error instanceof TokenBudgetExhausted)
          return collected.length === 0 ? null : collected;
        throw error;
      }
      total = combine(total, leaf.usage);
      if (leaf.output === null) {
        intact = false;
        this.recordFault(`${node.id}: round ${String(round)} dead`);
        continue;
      }
      if (
        isEmptyOutput(leaf.output) ||
        (Array.isArray(leaf.output) && leaf.output.length === 0) ||
        (asRecord(leaf.output) !== null && Object.keys(asRecord(leaf.output) ?? {}).length === 0)
      )
        empty += 1;
      else {
        collected.push(leaf.output);
        empty = 0;
      }
    }
    const output = collected;
    if (intact) this.cachePut(hash, node.id, output, total);
    return output;
  }

  private async runNested(node: Node, context: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (this.depth >= MAX_WORKFLOW_DEPTH) throw new Error(`workflow nesting exceeds depth ${String(MAX_WORKFLOW_DEPTH)}`);
    if (this.loader === undefined) throw new Error("workflow loader unavailable");
    const reference = strictResolve(node.fields.ref, context);
    if (typeof reference !== "string") return null;
    const raw = await this.loader(reference);
    const parsed = validateSpec(raw);
    if (parsed instanceof ValidationError) {
      this.recordFault(`${node.id}: invalid nested workflow: ${parsed.message}`);
      return null;
    }
    const args = asRecord(strictResolve(node.fields.args ?? {}, context)) ?? {};
    const nested = new WorkflowEngine({
      runtime: this.runtime,
      budget: this.budget,
      pool: this.pool,
      control: this.control,
      tiers: this.tiers,
      cache: this.cache,
      loader: this.loader,
      runId: this.runId,
      segmentId: this.segmentId,
      depth: this.depth + 1,
      nodeScope: [...this.nodeScope, node.id],
      checkpointAnswers: this.checkpointAnswers,
      pipelineTimeoutSeconds: this.pipelineTimeoutSeconds,
      ...(this.onEvent === undefined ? {} : { onEvent: this.onEvent }),
      logError: this.logError,
    });
    const result = await nested.run(parsed, args);
    this.result.nullCount += result.nullCount;
    this.result.nodesTotal += result.nodesTotal;
    this.result.tokensIn += result.tokensIn;
    this.result.tokensOut += result.tokensOut;
    this.result.cacheReadTokens += result.cacheReadTokens;
    this.result.cacheWriteTokens += result.cacheWriteTokens;
    this.result.reasoningTokens += result.reasoningTokens;
    for (const [nodeId, cost] of Object.entries(result.nodeCosts))
      this.result.nodeCosts[`sub[${reference}]:${nodeId}`] = cost;
    this.result.faults.push(...result.faults.map((fault) => `sub[${reference}]: ${fault}`));
    this.result.validationRetries += result.validationRetries;
    this.result.capTrips += result.capTrips;
    this.result.engineFaults += result.engineFaults;
    this.result.forcingFallbacks += result.forcingFallbacks;
    return Object.freeze({ ...result.outputs });
  }

  private async runGate(node: Node, context: Readonly<Record<string, unknown>>): Promise<unknown> {
    const body = asRecord(node.fields.body);
    const validator = strictResolve(node.fields.validator, context);
    if (body === null || validator === null) return null;
    const attempts = Math.min(Math.max(1, Math.trunc(Number(node.fields.attempts ?? 2))), MAX_GATE_ATTEMPTS);
    this.budget.checkFanout(attempts * 2);
    const prompt = strictResolve(body.prompt, context);
    if (prompt === null) return null;
    const hash = this.cell([node.id, "gate", prompt, this.schemaOf(body), validator, attempts, ...routingIdentity(node, this.tiers)]);
    const cached = this.cacheGet(hash);
    if (cached !== CACHE_MISS) return cached;
    let feedback = "";
    let total = usage();
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const draft = await this.collectLeaf(node, `${renderValue(prompt)}${feedback}`, this.schemaOf(body), { role: "gate.body", cellId: hash, attempt });
      total = combine(total, draft.usage);
      if (!nonEmpty(draft.output)) {
        feedback = "\n\nPrevious draft was empty; produce a complete draft.";
        continue;
      }
      const review = await this.collectLeaf(node, `${renderValue(validator)}\n\nCandidate:\n${renderValue(draft.output)}`, GATE_VERDICT_SCHEMA, { role: "gate.reviewer", cellId: hash, attempt });
      total = combine(total, review.usage);
      const verdict = asRecord(review.output);
      if (verdict?.ok === true) {
        this.cachePut(hash, node.id, draft.output, total);
        return draft.output;
      }
      feedback = `\n\nReviewer feedback: ${renderValue(verdict?.feedback ?? "revise")}`;
    }
    this.recordFault(`${node.id}: gate exhausted ${String(attempts)} attempts`);
    return null;
  }

  private async runCompleteness(node: Node, context: Readonly<Record<string, unknown>>): Promise<unknown> {
    const task = strictResolve(node.fields.task, context);
    const results = strictResolve(node.fields.results, context);
    if (task === null || results === null) return null;
    const schema = Object.freeze({
      type: "object",
      required: ["complete", "missing"],
      properties: { complete: { type: "boolean" }, missing: { type: "array", items: { type: "string" } } },
    });
    const hash = this.cell([node.id, "completeness_check", task, results, ...routingIdentity(node, this.tiers)]);
    const cached = this.cacheGet(hash);
    if (cached !== CACHE_MISS) return cached;
    const leaf = await this.collectLeaf(node, `Task: ${renderValue(task)}\nResults: ${renderValue(results)}`, schema, { role: "completeness", cellId: hash });
    if (leaf.output !== null) this.cachePut(hash, node.id, leaf.output, leaf.usage);
    return leaf.output;
  }

  private runCheckpoint(node: Node, context: Readonly<Record<string, unknown>>): unknown {
    const prompt = strictResolve(node.fields.prompt, context);
    if (prompt === null) return null;
    const hash = this.cell([node.id, "checkpoint", prompt]);
    const cached = this.cacheGet(hash);
    if (cached !== CACHE_MISS) return cached;
    if (Object.hasOwn(this.checkpointAnswers, node.id)) {
      const answer = this.checkpointAnswers[node.id];
      this.cache.put(this.runId, hash, node.id, answer, null);
      return answer;
    }
    const payload = Object.freeze({ node_id: node.id, prompt, ...(Object.hasOwn(node.fields, "default") ? { default: node.fields.default } : {}) });
    this.pause("checkpoint", `${node.id}: checkpoint waiting for answer`, payload);
    return null;
  }
}

const CACHE_MISS = Symbol("cache-miss");
