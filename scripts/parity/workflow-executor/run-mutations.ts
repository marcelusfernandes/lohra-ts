#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { canonicalJson } from "../canonical.js";

const root = resolve(process.cwd());
const focalTests = [
  "tests/workflow-executor.test.ts",
  "tests/workflow-nodes-tool.test.ts",
  "tests/workflow-hardening.test.ts",
] as const;

interface Edit {
  readonly file: string;
  readonly before: string;
  readonly after: string;
}

interface Mutant {
  readonly id: string;
  readonly mechanism: string;
  readonly edits: readonly Edit[];
}

const engine = "src/workflow/engine.ts";
const mutants: readonly Mutant[] = [
  {
    id: "engine-fault-swallow",
    mechanism: "unexpected strategy exception is silently swallowed",
    edits: [{
      file: engine,
      before: "          const cause = error instanceof Error ? `${error.name}: ${error.message}` : renderValue(error);\n          this.recordFault(`${node.id}: engine fault: ${cause}`);\n          this.result.engineFaults += 1;\n          this.logError(`workflow: engine fault at node ${node.id}`, error);",
      after: "          output = null;",
    }],
  },
  {
    id: "budget-drop-input",
    mechanism: "input tokens are removed from budget debit",
    edits: [{
      file: engine,
      before: "this.budget.chargeTokens(next.inputTokens, next.outputTokens);",
      after: "this.budget.chargeTokens(0, next.outputTokens);",
    }],
  },
  {
    id: "budget-add-reasoning",
    mechanism: "reasoning tokens incorrectly enlarge budget debit",
    edits: [{
      file: engine,
      before: "this.budget.chargeTokens(next.inputTokens, next.outputTokens);",
      after: "this.budget.chargeTokens(next.inputTokens, next.outputTokens + next.reasoningTokens);",
    }],
  },
  {
    id: "fanout-check-after-spawn",
    mechanism: "parallel fanout is rejected only after leaves have spawned",
    edits: [
      { file: engine, before: "    this.gateFanout(resolved.length);\n    const leaves = await Promise.all(", after: "    const leaves = await Promise.all(" },
      { file: engine, before: "    );\n    const outputs = leaves.map((leaf) => leaf.output);", after: "    );\n    this.gateFanout(resolved.length);\n    const outputs = leaves.map((leaf) => leaf.output);" },
    ],
  },
  {
    id: "pipeline-width-preflight-removed",
    mechanism: "pipeline item width is not checked before the first spawn",
    edits: [{
      file: engine,
      before: "    if (itemValues.length > 0) this.budget.checkFanout(itemValues.length);",
      after: "    void itemValues.length;",
    }],
  },
  {
    id: "draft202012-keywords-bypassed",
    mechanism: "Draft 2020-12 keyword failures are accepted",
    edits: [{
      file: "src/workflow/output-validation.ts",
      before: "    const errors = validateDraft202012(value, schema);",
      after: "    const errors: readonly string[] = [];",
    }],
  },
  {
    id: "dependent-schemas-ignored",
    mechanism: "dependentSchemas constraints are skipped",
    edits: [{
      file: "src/workflow/json-schema.ts",
      before: "    if (raw.dependentSchemas !== undefined) {\n      const dependencies = record(raw.dependentSchemas, `${path}.dependentSchemas`);",
      after: "    if (false && raw.dependentSchemas !== undefined) {\n      const dependencies = record(raw.dependentSchemas, `${path}.dependentSchemas`);",
    }],
  },
  {
    id: "property-names-ignored",
    mechanism: "propertyNames constraints are skipped",
    edits: [{
      file: "src/workflow/json-schema.ts",
      before: "    if (raw.propertyNames !== undefined) {\n      const propertySchema = schema(raw.propertyNames, `${path}.propertyNames`);",
      after: "    if (false && raw.propertyNames !== undefined) {\n      const propertySchema = schema(raw.propertyNames, `${path}.propertyNames`);",
    }],
  },
  {
    id: "unevaluated-properties-ignored",
    mechanism: "unevaluatedProperties constraints are skipped",
    edits: [{
      file: "src/workflow/json-schema.ts",
      before: "    if (raw.unevaluatedProperties !== undefined) {\n      const unevaluated = schema(raw.unevaluatedProperties, `${path}.unevaluatedProperties`);",
      after: "    if (false && raw.unevaluatedProperties !== undefined) {\n      const unevaluated = schema(raw.unevaluatedProperties, `${path}.unevaluatedProperties`);",
    }],
  },
  {
    id: "verify-lens-ignored",
    mechanism: "verify prompt ignores the selected skeptic lens",
    edits: [{
      file: engine,
      before: "        const lens: unknown = lenses[index % Math.max(1, lenses.length)] ?? \"general correctness\";",
      after: "        const lens: unknown = \"general correctness\";",
    }],
  },
  {
    id: "verify-schema-disabled",
    mechanism: "malformed skeptic verdicts bypass structured retries",
    edits: [{
      file: engine,
      before: "return this.collectLeaf(node, verifyPrompt(finding, lens), VERIFY_SCHEMA, {",
      after: "return this.collectLeaf(node, verifyPrompt(finding, lens), null, {",
    }],
  },
  {
    id: "judge-score-schema-disabled",
    mechanism: "judge reviewer textual scores bypass structured parsing and retries",
    edits: [{
      file: engine,
      before: "this.collectLeaf(node, `Score: ${renderValue(attempt.output)}`, JUDGE_SCORE_SCHEMA, {",
      after: "this.collectLeaf(node, `Score: ${renderValue(attempt.output)}`, null, {",
    }],
  },
  {
    id: "gate-verdict-schema-disabled",
    mechanism: "gate reviewer textual verdicts bypass structured parsing and retries",
    edits: [{
      file: engine,
      before: "`${renderValue(validator)}\\n\\nCandidate:\\n${renderValue(draft.output)}`, GATE_VERDICT_SCHEMA, {",
      after: "`${renderValue(validator)}\\n\\nCandidate:\\n${renderValue(draft.output)}`, null, {",
    }],
  },
  {
    id: "judge-winner-append-removed",
    mechanism: "synthesis prompt omits the mandatory winner suffix",
    edits: [{
      file: engine,
      before: "`${renderValue(prompt)}\\n\\nWINNER:\\n${renderValue(winner)}`",
      after: "renderValue(prompt)",
    }],
  },
  {
    id: "gate-uses-affordability-preflight",
    mechanism: "sequential gate is rejected by parallel affordability",
    edits: [{
      file: engine,
      before: "    this.budget.checkFanout(attempts * 2);",
      after: "    this.gateFanout(attempts * 2);",
    }],
  },
  {
    id: "budget-nan-unbounded",
    mechanism: "NaN structural limits survive normalization and disable caps",
    edits: [{
      file: "src/workflow/budget.ts",
      before: "  return Number.isNaN(normalized) ? 1 : Math.max(1, normalized);",
      after: "  return Math.max(1, normalized);",
    }],
  },
  {
    id: "timeout-no-cooperative-cancel",
    mechanism: "timed-out leaf is not cancelled",
    edits: [{ file: engine, before: "        await this.runtime.cancel(id);\n        this.recordFault", after: "        this.recordFault" }],
  },
  {
    id: "cache-cross-run",
    mechanism: "cache key ignores run id",
    edits: [{ file: "src/workflow/cache.ts", before: "return `${runId}\\0${hash}`;", after: "return hash;" }],
  },
  {
    id: "cache-empty-scalar",
    mechanism: "agent treats empty text as cacheable success",
    edits: [{ file: engine, before: "      if (!isEmptyOutput(leaf.output)) {", after: "      if (leaf.output !== null) {" }],
  },
  {
    id: "hash-remove-routing",
    mechanism: "routing fields are removed from cell identity",
    edits: [{
      file: "src/workflow/engine-utils.ts",
      before: "  if (![\"model\", \"tier\", \"effort\", \"provider\"].some((field) => Object.hasOwn(node.fields, field)))\n    return [];\n  const resolved = routingOf(node, tiers);\n  return [resolved.model ?? null, resolved.effort ?? null, resolved.provider ?? null];",
      after: "  void node;\n  void tiers;\n  return [];",
    }],
  },
  {
    id: "hash-remove-timeout",
    mechanism: "agent timeout is removed from cell identity",
    edits: [{ file: engine, before: "      node.fields.timeout ?? null,", after: "      null," }],
  },
  {
    id: "hash-append-undefined-max-iterations",
    mechanism: "absent max_iterations is always appended",
    edits: [{
      file: engine,
      before: "    if (Object.hasOwn(node.fields, \"max_iterations\")) parts.push(node.fields.max_iterations);",
      after: "    parts.push(node.fields.max_iterations);",
    }],
  },
  {
    id: "pipeline-global-stage-barrier",
    mechanism: "every item must finish a stage before any item enters the next",
    edits: [
      {
        file: engine,
        before: "    let expired = false;\n    const outputs:",
        after: "    let expired = false;\n    let barrierDone = 0;\n    let releaseBarrier: () => void = () => undefined;\n    const stageOneBarrier = new Promise<void>((resolveBarrier) => { releaseBarrier = resolveBarrier; });\n    const outputs:",
      },
      {
        file: engine,
        before: "        for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {\n          if (expired) return null;",
        after: "        for (let stageIndex = 0; stageIndex < stages.length; stageIndex += 1) {\n          if (stageIndex === 1) await stageOneBarrier;\n          if (expired) return null;",
      },
      {
        file: engine,
        before: "          previous = settled;\n        }\n        done += 1;",
        after: "          previous = settled;\n          if (stageIndex === 0) { barrierDone += 1; if (barrierDone === itemValues.length) releaseBarrier(); }\n        }\n        done += 1;",
      },
    ],
  },
  {
    id: "nested-budget-unshared",
    mechanism: "nested workflow receives a fresh budget",
    edits: [{ file: engine, before: "      budget: this.budget,", after: "      budget: new Budget()," }],
  },
  {
    id: "nested-cache-unshared",
    mechanism: "nested workflow receives a fresh cache",
    edits: [{ file: engine, before: "      cache: this.cache,", after: "      cache: new MemoryWorkflowCache()," }],
  },
  {
    id: "nested-fold-removed",
    mechanism: "nested faults, counters and costs are not folded",
    edits: [{
      file: engine,
      before: "    this.result.nullCount += result.nullCount;\n    this.result.nodesTotal += result.nodesTotal;\n    this.result.tokensIn += result.tokensIn;\n    this.result.tokensOut += result.tokensOut;\n    this.result.cacheReadTokens += result.cacheReadTokens;\n    this.result.cacheWriteTokens += result.cacheWriteTokens;\n    this.result.reasoningTokens += result.reasoningTokens;\n    for (const [nodeId, cost] of Object.entries(result.nodeCosts))\n      this.result.nodeCosts[`sub[${reference}]:${nodeId}`] = cost;\n    this.result.faults.push(...result.faults.map((fault) => `sub[${reference}]: ${fault}`));\n    this.result.validationRetries += result.validationRetries;\n    this.result.capTrips += result.capTrips;\n    this.result.engineFaults += result.engineFaults;\n    this.result.forcingFallbacks += result.forcingFallbacks;",
      after: "    void reference;",
    }],
  },
  {
    id: "nested-depth-unlimited",
    mechanism: "nested depth cap is disabled",
    edits: [{ file: engine, before: "    if (this.depth >= MAX_WORKFLOW_DEPTH) throw new Error", after: "    if (false) throw new Error" }],
  },
  {
    id: "sink-without-log",
    mechanism: "live sink exception disappears without a log",
    edits: [{ file: engine, before: "      this.logError(\"workflow: live event failed\", error);", after: "      void error;" }],
  },
  {
    id: "sink-alters-run",
    mechanism: "live sink exception changes semantic run counters",
    edits: [{ file: engine, before: "      this.eventSinkDisabled = true;\n      this.logError", after: "      this.eventSinkDisabled = true;\n      this.result.engineFaults += 1;\n      this.logError" }],
  },
  {
    id: "gate-reviewer-after-empty",
    mechanism: "reviewer is spawned after an empty draft",
    edits: [{
      file: engine,
      before: "        feedback = \"\\n\\nPrevious draft was empty; produce a complete draft.\";\n        continue;",
      after: "        feedback = \"\\n\\nPrevious draft was empty; produce a complete draft.\";",
    }],
  },
  {
    id: "judge-unconditional-synthesis-width",
    mechanism: "judge panel always reserves one synthesis leaf",
    edits: [{
      file: engine,
      before: "attempts.length + attempts.length * judges + (synth === null ? 0 : 1)",
      after: "attempts.length + attempts.length * judges + 1",
    }],
  },
  {
    id: "judge-dead-synthesis-winner",
    mechanism: "dead synthesis incorrectly returns the unsynthesized winner",
    edits: [{ file: engine, before: "    if (synthesis.output === null) return null;", after: "    if (synthesis.output === null) return winner;" }],
  },
  {
    id: "chat-without-real-dispatch",
    mechanism: "public handler no longer dispatches run_workflow",
    edits: [{ file: "src/workflow/tool.ts", before: "    run_workflow: (args) => tool.run(args),", after: "    run_workflow_disabled: (args) => tool.run(args)," }],
  },
];

function replaceExactlyOnce(source: string, before: string, after: string, id: string): string {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`${id}: mutation anchor not found`);
  if (source.indexOf(before, first + before.length) >= 0)
    throw new Error(`${id}: mutation anchor is not unique`);
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

function runTests(directory: string) {
  const result = spawnSync(join(directory, "node_modules/.bin/vitest"), ["run", ...focalTests], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  return {
    exitCode: result.status,
    stdoutTail: result.stdout.slice(-4_000),
    stderrTail: result.stderr.slice(-4_000),
  };
}

const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (status.status !== 0 || status.stdout !== "")
  throw new Error("mutation run requires a committed candidate with clean porcelain");
const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
if (head.status !== 0) throw new Error("cannot resolve candidate HEAD");
const candidateSha = head.stdout.trim();
const temporary = mkdtempSync(join(tmpdir(), "lohra-t15-mutations-"));

try {
  const archive = spawnSync("git", ["archive", "--format=tar", candidateSha], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (archive.status !== 0) throw new Error("git archive failed");
  const extracted = spawnSync("tar", ["-xf", "-", "-C", temporary], {
    input: archive.stdout,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (extracted.status !== 0) throw new Error("tar extraction failed");
  symlinkSync(resolve(root, "node_modules"), join(temporary, "node_modules"), "dir");

  const originals = new Map<string, string>();
  for (const mutant of mutants)
    for (const edit of mutant.edits)
      if (!originals.has(edit.file))
        originals.set(edit.file, readFileSync(join(temporary, edit.file), "utf8"));

  const baseline = runTests(temporary);
  if (baseline.exitCode !== 0) throw new Error("mutation baseline is not green");
  const results = [];
  for (const mutant of mutants) {
    for (const [file, original] of originals) writeFileSync(join(temporary, file), original, "utf8");
    for (const edit of mutant.edits) {
      const path = join(temporary, edit.file);
      const source = readFileSync(path, "utf8");
      writeFileSync(path, replaceExactlyOnce(source, edit.before, edit.after, mutant.id), "utf8");
    }
    const result = runTests(temporary);
    results.push({
      id: mutant.id,
      mechanism: mutant.mechanism,
      killed: result.exitCode !== 0,
      ...result,
    });
  }
  for (const [file, original] of originals) writeFileSync(join(temporary, file), original, "utf8");
  const restored = runTests(temporary);
  const survivors = results.filter((result) => !result.killed).map((result) => result.id);
  const evidence = {
    suite: "t15-workflow-mutations",
    candidateSha,
    copy: "temporary git archive of candidate SHA",
    baselineGreen: true,
    mutants: results,
    killed: results.length - survivors.length,
    total: results.length,
    survivors,
    restoreGreen: restored.exitCode === 0,
  };
  const evidenceDirectory = resolve(root, ".parity-evidence/t15");
  mkdirSync(evidenceDirectory, { recursive: true });
  const evidencePath = resolve(evidenceDirectory, "mutations.json");
  writeFileSync(evidencePath, canonicalJson(evidence), "utf8");
  process.stdout.write(
    `${JSON.stringify({ suite: evidence.suite, candidateSha, killed: evidence.killed, total: evidence.total, survivors, restoreGreen: evidence.restoreGreen, evidence: evidencePath })}\n`,
  );
  process.exitCode = survivors.length === 0 && restored.exitCode === 0 ? 0 : 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
