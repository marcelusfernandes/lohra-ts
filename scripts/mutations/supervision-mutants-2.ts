// Catálogo irmão de `supervision-mutants.ts` (issue #647, grupo A de #637,
// item 6): o primeiro estava em EXATAMENTE 800 linhas (PR #609/#627 já
// tinham desviado mutante para `workflow-audit-producers-mutants.ts` e
// `context-window.ts` por causa disso) e o próximo achado da fatia
// `supervision` não tinha onde morar sem apagar prosa. Recebe, movido sem
// alteração de `before`/`after`/`focus`, os 8 mutantes N1-N4/V1/W1/X1/Y1 do
// bloco final do catálogo original (abort em voo #519, `normalizeResumeId`
// #540, fold de faults #540 r2, achados 2/3 de #594).
//
// Arquivo separado de `supervision-mutants.ts` (não um `Files` que
// autorizasse crescer aquele arquivo além do teto de 800 linhas) — o
// runner de `supervision.ts` concatena os dois catálogos em `main()`. Dado
// puro (`export const supervisionMutants2`), sem `main()` de topo: seguro
// para `import` estático em `tests/mutations-slices.test.ts`, mesmo padrão
// de `context-prompt-mutants.ts` (issue #646).
import type { Mutant } from "./types.js";

const transportsClient = "src/transports/client.ts";
const orchestrationRuntime = "src/workflow/orchestration-runtime.ts";
const orchestrationCore = "src/orchestration/core.ts";
const childRunner = "src/orchestration/child-runner.ts";
const validation = "src/orchestration/validation.ts";
const accounting = "src/workflow/accounting.ts";

const abortInFlightFocus = "tests/transports-abort-in-flight.test.ts";
const childRunnerAbortFocus = "tests/orchestration-child-runner-abort.test.ts";
const workflowOrchestrationRuntimeTimeoutFocus =
  "tests/workflow-orchestration-runtime-timeout.test.ts";
const orchestrationToolsFocus = "tests/orchestration-tools.test.ts";
const workflowNodesToolFocus = "tests/workflow-nodes-tool.test.ts";
const steerInterruptFocus = "tests/orchestration-steer-interrupt.test.ts";

export const supervisionMutants2: readonly Mutant[] = [
  // --- abort em voo (M16, épico #490, issue #519) -------------------------
  // S1-S3/S5/S6 já mergearam o caminho de abort em voo (ADR 0005) sem
  // mutante cobrindo `stream()`'s propagação de `signal`, a reclassificação
  // de `error.partialUsage` em `child-runner.ts`, e o teto de espera de
  // `OrchestrationChildRuntime.cancel`.
  {
    id: "N1-anthropic-stream-signal-ignored",
    category: "anthropic-stream-signal-ignored",
    mechanism: "family-a",
    focus: {
      file: abortInFlightFocus,
      test: "AnthropicMessagesClient.stream forwards signal, replays partial text, and fills partial.usage from message_start",
    },
    edits: [
      {
        file: transportsClient,
        before:
          "    let response: HttpResponseData;\n    try {\n      response = await this.request({ ...kwargs, stream: true }, signal);\n    } catch (error) {\n      rethrowAborted(error, (partialBody) => {\n        const chunks = parseSse(partialBody, parseJsonPreservingNumbers, {",
        after:
          "    let response: HttpResponseData;\n    try {\n      response = await this.request({ ...kwargs, stream: true });\n    } catch (error) {\n      rethrowAborted(error, (partialBody) => {\n        const chunks = parseSse(partialBody, parseJsonPreservingNumbers, {",
      },
    ],
  },
  {
    // Re-anchored (issue #568 r2): usage now flows through combineUsage()
    // in child-runner.ts, not error.partialUsage alone — same intent.
    id: "N2-cancelled-leaf-usage-dropped",
    category: "cancelled-leaf-usage-dropped",
    mechanism: "family-a",
    focus: {
      file: childRunnerAbortFocus,
      test: "a stream torn down mid-flight resolves interrupted/cancelled with an estimated partial usage, never a bare zero",
    },
    edits: [
      {
        file: childRunner,
        before: "          const usage = combineUsage(error.measuredUsage, error.partialUsage);",
        after: "          const usage = null;",
      },
    ],
  },
  // N3 originally targeted `CANCEL_SETTLE_TIMEOUT_MS = 0` (#519): verified
  // NOT to kill (settles via microtasks, no real timer). Retargeted at
  // #521's sibling ceiling, `collect()`'s own `deadlineMs`.
  {
    id: "N3-collect-deadline-ceiling-widened",
    category: "collect-deadline-ceiling-widened",
    mechanism: "family-a",
    focus: {
      file: workflowOrchestrationRuntimeTimeoutFocus,
      test: "a leaf stuck mid-stream comes back running within the deadline, without cancelling it",
    },
    edits: [
      {
        file: orchestrationRuntime,
        before: "        ? Math.min(options.timeoutSeconds * 1000, 2_147_483_647)",
        after: "        ? Math.min(options.timeoutSeconds * 10_000, 2_147_483_647)",
      },
    ],
  },
  // Issue #567 (PR #525, r2 da PR #572): `parseSse` era atômico no abort —
  // N4 reverte o `tolerateTruncatedTail` inteiro, voltando o caminho de
  // abort a lançar sempre. O caminho normal já lançava antes e depois.
  {
    id: "N4-parse-sse-truncated-frame-atomic",
    category: "parse-sse-truncated-frame-atomic",
    mechanism: "family-a",
    focus: {
      file: abortInFlightFocus,
      test: "ChatCompletionsClient.stream replays the deltas already parsed when the trailing SSE frame is truncated mid-abort (issue #567)",
    },
    edits: [
      {
        file: transportsClient,
        before:
          '    if (!data) continue;\n    if (data === "[DONE]") break;\n    if (options.tolerateTruncatedTail !== true) {\n      chunks.push(parse(data));\n      continue;\n    }\n    try {\n      chunks.push(parse(data));\n    } catch {\n      // Abort path only (tolerateTruncatedTail): nothing after this block\n      // could be valid either, so stop here instead of skipping ahead.\n      break;\n    }',
        after:
          '    if (!data) continue;\n    if (data === "[DONE]") break;\n    chunks.push(parse(data));',
      },
    ],
  },
  // #540 achado 5: normalizeResumeId sem mutante — off-by-one no trim (`0`->`1`).
  {
    id: "V1-normalize-resume-id-trim-off-by-one",
    category: "normalize-resume-id-trim-off-by-one",
    mechanism: "family-a",
    focus: {
      file: orchestrationToolsFocus,
      test: 'drops the "resume_id" key entirely for empty, whitespace-only, null and undefined values',
    },
    edits: [
      {
        file: validation,
        before: '    (typeof resume_id === "string" && resume_id.trim().length === 0);',
        after: '    (typeof resume_id === "string" && resume_id.trim().length === 1);',
      },
    ],
  },
  // #540 achado 2b: fold de faults (foldNestedCounters) sem mutante.
  {
    id: "W1-nested-faults-fold-drops-prefix",
    category: "nested-faults-fold-drops-prefix",
    mechanism: "family-a",
    focus: {
      file: workflowNodesToolFocus,
      test: "folds nested faults, node counts and all five cost meters",
    },
    edits: [
      {
        file: accounting,
        before:
          "  result.faults.push(...nested.faults.map((fault) => `${nestedScopePrefix(reference)}${fault}`));",
        after: "  result.faults.push(...nested.faults);",
      },
    ],
  },
  // --- issue #594 (residual de M21) ---------------------------------------
  // Achado 1/2: `MaxIterationsError.partialCalls` guard sem mutante.
  {
    id: "X1-max-iterations-partial-guard-removed",
    category: "max-iterations-partial-guard-removed",
    mechanism: "family-a",
    // Achado 2 (#594): remove a guarda -- TODO cap-hit vira partial.
    focus: {
      file: "tests/orchestration-child-runner.test.ts",
      test: "maps MaxIterationsError to status:'error' with the child's own leash, ignoring env (L10)",
    },
    edits: [
      {
        file: childRunner,
        before:
          "          return error.partialCalls > 0 ? { ...base, partial: true, usageUncertain: true } : base;",
        after: "          return { ...base, partial: true, usageUncertain: true };",
      },
    ],
  },
  // Achado 3: `arm`'s `fire` (disarm-on-fire) sem mutante — `focusFiles`
  // não listava `orchestration-steer-interrupt.test.ts` (fix em `slices.json`).
  {
    id: "Y1-steer-fire-not-idempotent",
    category: "steer-fire-not-idempotent",
    mechanism: "family-a",
    focus: {
      file: steerInterruptFocus,
      test: "a second steer while the first's interrupt is still in flight never re-reports interrupted, and the hook fires exactly once",
    },
    edits: [
      {
        file: orchestrationCore,
        before:
          "        const fire = (): void => {\n          const current = this.entries.get(subId);\n          if (current !== undefined && current.interrupt === fire) current.interrupt = null;\n          abort();\n        };",
        after: "        const fire = (): void => {\n          abort();\n        };",
      },
    ],
  },
];
