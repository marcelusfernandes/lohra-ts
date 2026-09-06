#!/usr/bin/env node
// T15 mutation harness — external proof on a TEMPORARY git archive of the
// committed candidate SHA (never the working checkout). Issue #149 (passo
// 0b do épico #13): migrado do runner legado de paridade para
// `scripts/mutations/**`, sobre o harness comum de `harness.ts` (#148).
// Os mutantes não mudam — mesmos ids/before/after — só o transporte.
//
// Ao contrário de t16, t15 não afunila num foco por mutante: a mesma
// bateria de cinco arquivos focais roda inteira para cada um dos 44
// mutantes (`runVitestFiles`, sem `-t`) — é assim que o runner original
// já funcionava, e a issue #149 não muda mutante nenhum. O quinto arquivo
// (`tests/mutations-fixtures-workflow-executor.test.ts`) é NOVO: cobre os
// três mutantes cujo alvo é uma cópia sob `scripts/mutations/fixtures/`
// em vez de `src/**`.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

import {
  applyEditExactlyOnce,
  assertBaselineGreen,
  assertRestoreGreen,
  classify,
  prepareArchiveSandbox,
  restoreAll as restoreSnapshot,
  runVitestFiles,
  snapshotFiles,
  writeReport,
} from "./harness.js";
import type { Edit, MutationReport } from "./types.js";

const root = resolve(process.cwd());
const focalTests = [
  "tests/workflow-executor.test.ts",
  "tests/workflow-nodes-tool.test.ts",
  "tests/workflow-hardening.test.ts",
  "tests/parity/scenarios.test.ts",
  "tests/mutations-fixtures-workflow-executor.test.ts",
] as const;

interface ExecutorMutant {
  readonly id: string;
  readonly mechanism: string;
  readonly edits: readonly Edit[];
}

const engine = "src/workflow/engine.ts";
export const executorMutants: readonly ExecutorMutant[] = [
  {
    id: "engine-fault-swallow",
    mechanism: "unexpected strategy exception is silently swallowed",
    edits: [
      {
        file: engine,
        before:
          "          const cause =\n            error instanceof Error ? `${error.name}: ${error.message}` : renderValue(error);\n          this.recordFault(`${node.id}: engine fault: ${cause}`);\n          this.result.engineFaults += 1;\n          this.logError(`workflow: engine fault at node ${node.id}`, error);",
        after: "          output = null;",
      },
    ],
  },
  {
    id: "budget-drop-input",
    mechanism: "input tokens are removed from budget debit",
    edits: [
      {
        file: engine,
        before: "this.budget.chargeTokens(next.inputTokens, next.outputTokens);",
        after: "this.budget.chargeTokens(0, next.outputTokens);",
      },
    ],
  },
  {
    id: "budget-add-reasoning",
    mechanism: "reasoning tokens incorrectly enlarge budget debit",
    edits: [
      {
        file: engine,
        before: "this.budget.chargeTokens(next.inputTokens, next.outputTokens);",
        after:
          "this.budget.chargeTokens(next.inputTokens, next.outputTokens + next.reasoningTokens);",
      },
    ],
  },
  {
    id: "fanout-check-after-spawn",
    mechanism: "parallel fanout is rejected only after leaves have spawned",
    edits: [
      {
        file: engine,
        before: "    this.gateFanout(resolved.length);\n    const leaves = await Promise.all(",
        after: "    const leaves = await Promise.all(",
      },
      {
        file: engine,
        before: "    );\n    const outputs = leaves.map((leaf) => leaf.output);",
        after:
          "    );\n    this.gateFanout(resolved.length);\n    const outputs = leaves.map((leaf) => leaf.output);",
      },
    ],
  },
  {
    id: "pipeline-width-preflight-removed",
    mechanism: "pipeline item width is not checked before the first spawn",
    edits: [
      {
        file: engine,
        before: "    if (itemValues.length > 0) this.budget.checkFanout(itemValues.length);",
        after: "    void itemValues.length;",
      },
    ],
  },
  {
    id: "draft202012-keywords-bypassed",
    mechanism: "Draft 2020-12 keyword failures are accepted",
    edits: [
      {
        file: "src/workflow/output-validation.ts",
        before: "    const errors = validateDraft202012(value, schema);",
        after: "    const errors: readonly string[] = [];",
      },
    ],
  },
  {
    id: "dependent-schemas-ignored",
    mechanism: "dependentSchemas constraints are skipped",
    edits: [
      {
        file: "src/workflow/json-schema.ts",
        before:
          "    if (raw.dependentSchemas !== undefined) {\n      const dependencies = record(raw.dependentSchemas, `${path}.dependentSchemas`);",
        after:
          "    if (false && raw.dependentSchemas !== undefined) {\n      const dependencies = record(raw.dependentSchemas, `${path}.dependentSchemas`);",
      },
    ],
  },
  {
    id: "property-names-ignored",
    mechanism: "propertyNames constraints are skipped",
    edits: [
      {
        file: "src/workflow/json-schema.ts",
        before:
          "    if (raw.propertyNames !== undefined) {\n      const propertySchema = schema(raw.propertyNames, `${path}.propertyNames`);",
        after:
          "    if (false && raw.propertyNames !== undefined) {\n      const propertySchema = schema(raw.propertyNames, `${path}.propertyNames`);",
      },
    ],
  },
  {
    id: "unevaluated-properties-ignored",
    mechanism: "unevaluatedProperties constraints are skipped",
    edits: [
      {
        file: "src/workflow/json-schema.ts",
        before:
          "    if (raw.unevaluatedProperties !== undefined) {\n      const unevaluated = schema(raw.unevaluatedProperties, `${path}.unevaluatedProperties`);",
        after:
          "    if (false && raw.unevaluatedProperties !== undefined) {\n      const unevaluated = schema(raw.unevaluatedProperties, `${path}.unevaluatedProperties`);",
      },
    ],
  },
  {
    id: "local-anchor-resolution-disabled",
    mechanism: "plain local anchors cannot resolve",
    edits: [
      {
        file: "src/workflow/json-schema.ts",
        before: 'candidate[dynamic ? "$dynamicAnchor" : "$anchor"] === name ||',
        after: "candidate.$dynamicAnchor === name ||",
      },
    ],
  },
  {
    id: "dynamic-reference-resolution-disabled",
    mechanism: "dynamicRef is treated as an ignored annotation",
    edits: [
      {
        file: "src/workflow/json-schema.ts",
        before:
          '  if (typeof raw.$dynamicRef === "string")\n    errors.push(...validate(value, resolveReference(root, raw.$dynamicRef, true), path, root));',
        after: "  void raw.$dynamicRef;",
      },
    ],
  },
  {
    id: "embedded-id-resolution-disabled",
    mechanism: "embedded resources cannot resolve by id",
    edits: [
      {
        file: "src/workflow/json-schema.ts",
        before: "  const resource = findSchema(root, (candidate) => candidate.$id === resourceId);",
        after: "  const resource = findSchema(root, () => false);",
      },
    ],
  },
  {
    id: "json-pointer-resolution-disabled",
    mechanism: "existing local JSON Pointer refs regress",
    edits: [
      {
        file: "src/workflow/json-schema.ts",
        before:
          '  if (reference === "#") return root;\n  if (reference.startsWith("#/")) return pointer(root, reference);',
        after:
          '  if (reference === "#") return root;\n  if (reference.startsWith("#/")) throw new SchemaDefinitionError("pointer disabled");',
      },
    ],
  },
  {
    id: "unresolved-reference-accepted",
    mechanism: "unresolved external refs are silently accepted",
    edits: [
      {
        file: "src/workflow/json-schema.ts",
        before:
          "  if (resource === undefined)\n    throw new SchemaDefinitionError(\n      `unresolved reference ${reference}; external resolution disabled`,\n    );",
        after: "  if (resource === undefined) return true;",
      },
    ],
  },
  {
    id: "multiple-of-float-tolerance",
    mechanism: "multipleOf uses a tolerance instead of pinned oracle quotient arithmetic",
    edits: [
      {
        file: "src/workflow/json-schema.ts",
        before: "      if (Math.trunc(quotient) !== quotient)",
        after: "      if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * 10)",
      },
    ],
  },
  {
    id: "verify-lens-ignored",
    mechanism: "verify prompt ignores the selected skeptic lens",
    edits: [
      {
        file: engine,
        before:
          '        const lens: unknown = lenses[index % Math.max(1, lenses.length)] ?? "general correctness";',
        after: '        const lens: unknown = "general correctness";',
      },
    ],
  },
  {
    id: "verify-schema-disabled",
    mechanism: "malformed skeptic verdicts bypass structured retries",
    edits: [
      {
        file: engine,
        before: "return this.collectLeaf(node, verifyPrompt(finding, lens), VERIFY_SCHEMA, {",
        after: "return this.collectLeaf(node, verifyPrompt(finding, lens), null, {",
      },
    ],
  },
  {
    id: "judge-score-schema-disabled",
    mechanism: "judge reviewer textual scores bypass structured parsing and retries",
    edits: [
      {
        file: engine,
        before:
          "this.collectLeaf(node, `Score: ${renderValue(attempt.output)}`, JUDGE_SCORE_SCHEMA, {",
        after: "this.collectLeaf(node, `Score: ${renderValue(attempt.output)}`, null, {",
      },
    ],
  },
  {
    id: "gate-verdict-schema-disabled",
    mechanism: "gate reviewer textual verdicts bypass structured parsing and retries",
    edits: [
      {
        file: engine,
        before:
          "`${renderValue(validator)}\\n\\nCandidate:\\n${renderValue(draft.output)}`,\n        GATE_VERDICT_SCHEMA,\n        {",
        after:
          "`${renderValue(validator)}\\n\\nCandidate:\\n${renderValue(draft.output)}`,\n        null,\n        {",
      },
    ],
  },
  {
    id: "judge-winner-append-removed",
    mechanism: "synthesis prompt omits the mandatory winner suffix",
    edits: [
      {
        file: engine,
        before: "`${renderValue(prompt)}\\n\\nWINNER:\\n${renderValue(winner)}`",
        after: "renderValue(prompt)",
      },
    ],
  },
  {
    id: "gate-uses-affordability-preflight",
    mechanism: "sequential gate is rejected by parallel affordability",
    edits: [
      {
        file: engine,
        before: "    this.budget.checkFanout(attempts * 2);",
        after: "    this.gateFanout(attempts * 2);",
      },
    ],
  },
  {
    id: "budget-nan-unbounded",
    mechanism: "NaN structural limits survive normalization and disable caps",
    edits: [
      {
        file: "src/workflow/budget.ts",
        before: "  return Number.isNaN(normalized) ? 1 : Math.max(1, normalized);",
        after: "  return Math.max(1, normalized);",
      },
    ],
  },
  {
    id: "timeout-no-cooperative-cancel",
    mechanism: "timed-out leaf is not cancelled",
    edits: [
      {
        file: engine,
        before: "        await this.runtime.cancel(id);\n        this.recordFault",
        after: "        this.recordFault",
      },
    ],
  },
  {
    id: "cache-cross-run",
    mechanism: "cache key ignores run id",
    edits: [
      {
        file: "src/workflow/cache.ts",
        before: "return `${runId}\\0${hash}`;",
        after: "return hash;",
      },
    ],
  },
  {
    id: "cache-empty-scalar",
    mechanism: "agent treats empty text as cacheable success",
    edits: [
      {
        file: engine,
        before: "      if (!isEmptyOutput(leaf.output)) {",
        after: "      if (leaf.output !== null) {",
      },
    ],
  },
  {
    id: "hash-remove-routing",
    mechanism: "routing fields are removed from cell identity",
    edits: [
      {
        file: "src/workflow/engine-utils.ts",
        before:
          '  if (!["model", "tier", "effort", "provider"].some((field) => Object.hasOwn(node.fields, field)))\n    return [];\n  const resolved = routingOf(node, tiers);\n  return [resolved.model ?? null, resolved.effort ?? null, resolved.provider ?? null];',
        after: "  void node;\n  void tiers;\n  return [];",
      },
    ],
  },
  {
    id: "hash-remove-timeout",
    mechanism: "agent timeout is removed from cell identity",
    edits: [{ file: engine, before: "      node.fields.timeout ?? null,", after: "      null," }],
  },
  {
    id: "hash-append-undefined-max-iterations",
    mechanism: "absent max_iterations is always appended",
    edits: [
      {
        file: engine,
        before:
          '    if (Object.hasOwn(node.fields, "max_iterations")) parts.push(node.fields.max_iterations);',
        after: "    parts.push(node.fields.max_iterations);",
      },
    ],
  },
  {
    id: "pipeline-global-stage-barrier",
    mechanism: "every item must finish a stage before any item enters the next",
    edits: [
      {
        file: engine,
        before: "    let expired = false;\n    const outputs:",
        after:
          "    let expired = false;\n    let barrierDone = 0;\n    let releaseBarrier: () => void = () => undefined;\n    const stageOneBarrier = new Promise<void>((resolveBarrier) => { releaseBarrier = resolveBarrier; });\n    const outputs:",
      },
      {
        file: engine,
        before:
          "        for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {\n          if (expired) return null;",
        after:
          "        for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {\n          if (stageIndex === 1) await stageOneBarrier;\n          if (expired) return null;",
      },
      {
        file: engine,
        before: "          previous = settled;\n        }\n        done += 1;",
        after:
          "          previous = settled;\n          if (stageIndex === 0) { barrierDone += 1; if (barrierDone === itemValues.length) releaseBarrier(); }\n        }\n        done += 1;",
      },
    ],
  },
  {
    id: "nested-budget-unshared",
    mechanism: "nested workflow receives a fresh budget",
    edits: [
      { file: engine, before: "      budget: this.budget,", after: "      budget: new Budget()," },
    ],
  },
  {
    id: "nested-cache-unshared",
    mechanism: "nested workflow receives a fresh cache",
    edits: [
      {
        file: engine,
        before: "      cache: this.cache,",
        after: "      cache: new MemoryWorkflowCache(),",
      },
    ],
  },
  {
    id: "nested-fold-removed",
    mechanism: "nested faults, counters and costs are not folded",
    edits: [
      {
        file: engine,
        before:
          "    this.result.nullCount += result.nullCount;\n    this.result.nodesTotal += result.nodesTotal;\n    this.result.tokensIn += result.tokensIn;\n    this.result.tokensOut += result.tokensOut;\n    this.result.cacheReadTokens += result.cacheReadTokens;\n    this.result.cacheWriteTokens += result.cacheWriteTokens;\n    this.result.reasoningTokens += result.reasoningTokens;\n    for (const [nodeId, cost] of Object.entries(result.nodeCosts))\n      this.result.nodeCosts[`sub[${reference}]:${nodeId}`] = cost;\n    this.result.faults.push(...result.faults.map((fault) => `sub[${reference}]: ${fault}`));\n    this.result.validationRetries += result.validationRetries;\n    this.result.capTrips += result.capTrips;\n    this.result.engineFaults += result.engineFaults;\n    this.result.forcingFallbacks += result.forcingFallbacks;",
        after: "    void reference;",
      },
    ],
  },
  {
    id: "nested-depth-unlimited",
    mechanism: "nested depth cap is disabled",
    edits: [
      {
        file: engine,
        before: "    if (this.depth >= MAX_WORKFLOW_DEPTH)\n      throw new Error",
        after: "    if (false)\n      throw new Error",
      },
    ],
  },
  {
    id: "sink-without-log",
    mechanism: "live sink exception disappears without a log",
    edits: [
      {
        file: engine,
        before: '      this.logError("workflow: live event failed", error);',
        after: "      void error;",
      },
    ],
  },
  {
    id: "sink-alters-run",
    mechanism: "live sink exception changes semantic run counters",
    edits: [
      {
        file: engine,
        before: '      this.logError("workflow: live event failed", error);',
        after:
          '      this.result.engineFaults += 1;\n      this.logError("workflow: live event failed", error);',
      },
    ],
  },
  {
    id: "gate-reviewer-after-empty",
    mechanism: "reviewer is spawned after an empty draft",
    edits: [
      {
        file: engine,
        before:
          '        feedback = "\\n\\nPrevious draft was empty; produce a complete draft.";\n        continue;',
        after: '        feedback = "\\n\\nPrevious draft was empty; produce a complete draft.";',
      },
    ],
  },
  {
    id: "judge-unconditional-synthesis-width",
    mechanism: "judge panel always reserves one synthesis leaf",
    edits: [
      {
        file: engine,
        before: "attempts.length + attempts.length * judges + (synth === null ? 0 : 1)",
        after: "attempts.length + attempts.length * judges + 1",
      },
    ],
  },
  {
    id: "judge-dead-synthesis-winner",
    mechanism: "dead synthesis incorrectly returns the unsynthesized winner",
    edits: [
      {
        file: engine,
        before: "    if (synthesis.output === null) return null;",
        after: "    if (synthesis.output === null) return winner;",
      },
    ],
  },
  {
    id: "chat-without-real-dispatch",
    mechanism: "public handler no longer dispatches run_workflow",
    edits: [
      {
        file: "src/workflow/tool.ts",
        before: "    run_workflow: (args) => tool.run(args),",
        after: "    run_workflow_disabled: (args) => tool.run(args),",
      },
    ],
  },
  {
    id: "chat-run-id-normalization-removed",
    mechanism:
      "volatile nested run_id is no longer normalized before the events.requests comparison",
    edits: [
      {
        file: "scripts/mutations/fixtures/t15-chat-workflow.json",
        before: `    {
      "field": "events.requests",
      "kind": "replace-regex",
      "pattern": "\\"run_id\\": \\"[^\\" ]+",
      "replacement": "\\"run_id\\": \\"<run-id>"
    }
  ],`,
        after: `  ],`,
      },
    ],
  },
  {
    id: "chat-requests-comparison-removed",
    mechanism: "events.request bodies are dropped from the real comparison set",
    edits: [
      {
        file: "scripts/mutations/fixtures/t15-chat-workflow.json",
        before: `    { "class": "stub", "field": "events.requests" },\n`,
        after: ``,
      },
    ],
  },
  {
    id: "chat-start-status-running",
    mechanism: "run_workflow start envelope reports running instead of the pinned started",
    edits: [
      {
        file: "src/workflow/service.ts",
        before: `    return Object.freeze({ run_id: runId, status: "started" as const });
  }

  // --- durable launch/resume`,
        after: `    return Object.freeze({ run_id: runId, status: "running" as const });
  }

  // --- durable launch/resume`,
      },
    ],
  },
  {
    id: "chat-start-reinsert-name",
    mechanism: "run_workflow start envelope re-adds the name field the oracle omits",
    edits: [
      {
        file: "src/workflow/service.ts",
        before: `    return Object.freeze({ run_id: runId, status: "started" as const });
  }

  // --- durable launch/resume`,
        after: `    return Object.freeze({ run_id: runId, name: parsed.name, status: "started" as const });
  }

  // --- durable launch/resume`,
      },
    ],
  },
  {
    id: "chat-prompt-composition-removed",
    mechanism: "candidate probe reverts to the bare canned system prompt",
    edits: [
      {
        file: "scripts/mutations/fixtures/candidate-chat.mjs",
        before: `promptSnapshot: () => buildSystemPrompt({ systemMessage: "T15 canned workflow chat" }).text,`,
        after: `promptSnapshot: () => "T15 canned workflow chat",`,
      },
    ],
  },
];

interface ExecutorMutationReport extends MutationReport {
  readonly mutants: readonly {
    readonly id: string;
    readonly mechanism: string;
    readonly killed: boolean;
    readonly ranTests: number;
    readonly killedBy: readonly string[];
  }[];
}

function main(): void {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (head.status !== 0) throw new Error("cannot resolve candidate HEAD");
  const candidateSha = head.stdout.trim();

  const sandbox = prepareArchiveSandbox(root, candidateSha);
  try {
    const files = [...new Set(executorMutants.flatMap((m) => m.edits.map((e) => e.file)))];
    const snapshot = snapshotFiles(sandbox, files);
    const restoreAll = (): void => {
      restoreSnapshot(sandbox, snapshot);
    };

    const baseline = runVitestFiles(sandbox, focalTests);
    assertBaselineGreen(baseline, "t15 baseline");

    const results = executorMutants.map((mutant) => {
      restoreAll();
      for (const edit of mutant.edits) applyEditExactlyOnce(sandbox, edit, mutant.id);
      const outcome = runVitestFiles(sandbox, focalTests);
      return {
        id: mutant.id,
        mechanism: mutant.mechanism,
        ranTests: outcome.ranTests,
        killed: classify(outcome.exitCode, outcome.failedTests),
        killedBy: outcome.failedTests,
      };
    });

    restoreAll();
    const restored = runVitestFiles(sandbox, focalTests);
    const restoreGreen = assertRestoreGreen(restored);

    const survivors = results.filter((result) => !result.killed).map((result) => result.id);
    const evidence: ExecutorMutationReport = {
      suite: "t15-workflow-mutations",
      candidateSha,
      mutants: results,
      killed: results.length - survivors.length,
      total: results.length,
      survivors,
      restoreGreen,
    };
    const evidenceDirectory = resolve(root, ".mutation-evidence/t15");
    writeReport(evidenceDirectory, evidence);
    process.stdout.write(
      `${JSON.stringify({
        suite: evidence.suite,
        candidateSha,
        killed: evidence.killed,
        total: evidence.total,
        survivors,
        restoreGreen,
        evidence: resolve(evidenceDirectory, "mutations.json"),
      })}\n`,
    );
    process.exitCode = survivors.length === 0 && restoreGreen ? 0 : 1;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

main();
