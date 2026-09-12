// Catálogo de 20 mutantes da fatia `supervision` (issue #451, milestone 14 —
// achado de QA/revisão de M10, épico #421): `npm run mutations:all` seguia
// 227/227 apesar de ~1.000 linhas novas em `src/workflow/{steer-tool,
// leaf-read-tool,route-faults,route-override}.ts`, no bloco de steer de
// `src/orchestration/core.ts`, no guard de `dead_turn` de
// `src/orchestration/child-runner.ts` e no vocabulário de
// `src/transports/error-kinds.ts` — nenhum `before:` ancorava ali e
// `transports` nunca teve fatia nenhuma. Mesma mecânica A (git-archive +
// vitest focado) dos outros catálogos (`scripts/mutations/harness.ts`,
// issue #148); `mechanism: "family-a"` é só rótulo descritivo, mesma
// convenção de `workflow-audit-producers-mutants.ts`.
//
// `category` deriva do `id` sem o prefixo `<letra><n>-`. `focus.test` é o
// título literal do `it` (substring do `fullName`, veredito da PR #371/#362)
// — nunca um padrão de regex.
import type { Mutant } from "./types.js";

const steerTool = "src/workflow/steer-tool.ts";
const leafReadTool = "src/workflow/leaf-read-tool.ts";
const routeFaults = "src/workflow/route-faults.ts";
const routeOverride = "src/workflow/route-override.ts";
const engine = "src/workflow/engine.ts";
const auditRuntime = "src/workflow/audit-runtime.ts";
const orchestrationCore = "src/orchestration/core.ts";
const childRunner = "src/orchestration/child-runner.ts";
const errorKinds = "src/transports/error-kinds.ts";

const steerToolFocus = "tests/workflow-steer-tool.test.ts";
const leafReadFocus = "tests/workflow-leaf-read-tool.test.ts";
const routeFaultsFocus = "tests/workflow-route-faults.test.ts";
const routeOverrideFocus = "tests/workflow-route-override.test.ts";
const routeOverrideNestedFocus = "tests/workflow-route-override-nested.test.ts";
const delegateEnvelopeFocus = "tests/orchestration-delegate-envelope.test.ts";
const transportErrorKindsFocus = "tests/transport-error-kinds.test.ts";

export const supervisionMutants: readonly Mutant[] = [
  // --- steer-tool.ts (#424, #445, #450) -----------------------------------
  {
    id: "S1-steer-outcome-undefined-fabricates-queued",
    category: "steer-outcome-undefined-fabricates-queued",
    mechanism: "family-a",
    focus: {
      file: steerToolFocus,
      test: "a runtime that reports no steerOutcome at all is a named fail-closed error, never queued:true (#450)",
    },
    edits: [
      {
        file: steerTool,
        before:
          "    if (runtime.steerOutcome === undefined) {\n      return toolError(`workflow_steer: runtime sem steerOutcome for sub_id '${subId}'`);\n    }",
        after:
          "    if (runtime.steerOutcome === undefined) {\n      return toolResult(undefined, {\n        sub_id: subId,\n        node_id: nodeId ?? nodeIdOfSubId(audit, runId, subId) ?? null,\n        queued: true,\n      });\n    }",
      },
    ],
  },
  {
    id: "S2-resolution-window-ceiling-widened",
    category: "resolution-window-ceiling-widened",
    mechanism: "family-a",
    focus: {
      file: steerToolFocus,
      test: "node_id resolution above the pagination ceiling is a named 'window truncated' error, distinct from 'no live leaf' (#445)",
    },
    edits: [
      {
        file: steerTool,
        before: "const MAX_RESOLUTION_EVENTS = 2_000;",
        after: "const MAX_RESOLUTION_EVENTS = 20_000;",
      },
    ],
  },
  {
    id: "S3-ambiguous-guard-off-by-one",
    category: "ambiguous-guard-off-by-one",
    mechanism: "family-a",
    focus: {
      file: steerToolFocus,
      test: "node_id with more than one live leaf is a named ambiguous error, runtime never touched",
    },
    edits: [
      {
        file: steerTool,
        before: "  if (candidates.length > 1)",
        after: "  if (candidates.length > 2)",
      },
    ],
  },
  // --- leaf-read-tool.ts (#425, #432, #435) -------------------------------
  {
    id: "L1-empty-turn-guard-order-swapped",
    category: "empty-turn-guard-order-swapped",
    mechanism: "family-a",
    focus: {
      file: leafReadFocus,
      test: "does not report truncated:true for a turn that was already empty",
    },
    edits: [
      {
        file: leafReadTool,
        before:
          '    if (row.content.length === 0) return { role: row.role, content: "", created_at: row.timestamp };\n    if (budget <= 0) {\n      truncated = true;\n      return { role: row.role, content: "", created_at: row.timestamp };\n    }',
        after:
          '    if (budget <= 0) {\n      truncated = true;\n      return { role: row.role, content: "", created_at: row.timestamp };\n    }\n    if (row.content.length === 0) return { role: row.role, content: "", created_at: row.timestamp };',
      },
    ],
  },
  {
    id: "L2-max-turns-cap-widened",
    category: "max-turns-cap-widened",
    mechanism: "family-a",
    focus: {
      file: leafReadFocus,
      test: "caps the turns returned at MAX_TURNS (200), keeping the MOST RECENT ones",
    },
    edits: [
      {
        file: leafReadTool,
        before: "const MAX_TURNS = 200;",
        after: "const MAX_TURNS = 201;",
      },
    ],
  },
  // --- route-faults.ts (#426, #449) ---------------------------------------
  {
    id: "R1-pauses-run-always-false",
    category: "pauses-run-always-false",
    mechanism: "family-a",
    focus: {
      file: routeFaultsFocus,
      test: "pausesRun is true for quota_exhausted and the three route kinds, false otherwise",
    },
    edits: [
      {
        file: routeFaults,
        before:
          "export function pausesRun(kind: ErrorKind | null | undefined): boolean {\n  return kind === QUOTA_EXHAUSTED || isRouteFault(kind);\n}",
        after:
          "export function pausesRun(kind: ErrorKind | null | undefined): boolean {\n  void kind;\n  return false;\n}",
      },
    ],
  },
  {
    id: "R2-route-fault-kind-missing",
    category: "route-fault-kind-missing",
    mechanism: "family-a",
    focus: {
      file: routeFaultsFocus,
      test: "isRouteFault is true only for the three route kinds, never quota_exhausted or others",
    },
    edits: [
      {
        file: routeFaults,
        before:
          'const ROUTE_FAULT_KINDS: ReadonlySet<string> = new Set([\n  "auth_failed",\n  "route_fault",\n  "model_not_found",\n]);',
        after:
          'const ROUTE_FAULT_KINDS: ReadonlySet<string> = new Set([\n  "auth_failed",\n  "route_fault",\n]);',
      },
    ],
  },
  {
    id: "R3-is-route-lesson-always-true",
    category: "is-route-lesson-always-true",
    mechanism: "family-a",
    focus: {
      file: routeFaultsFocus,
      test: "a checkpoint that isn't a RouteLesson never reaches the repository — warn says so",
    },
    edits: [
      {
        file: routeFaults,
        before:
          'export function isRouteLesson(value: unknown): value is RouteLesson {\n  if (value === null || typeof value !== "object") return false;\n  const candidate = value as Readonly<Record<string, unknown>>;\n  return (\n    typeof candidate.error_kind === "string" &&\n    isRouteFault(candidate.error_kind as ErrorKind) &&\n    typeof candidate.node_id === "string" &&\n    (candidate.provider === null || typeof candidate.provider === "string") &&\n    (candidate.model === null || typeof candidate.model === "string") &&\n    candidate.suggested_route === null\n  );\n}',
        after:
          "export function isRouteLesson(value: unknown): value is RouteLesson {\n  void value;\n  return true;\n}",
      },
    ],
  },
  {
    id: "R4-append-safe-try-catch-removed",
    category: "append-safe-try-catch-removed",
    mechanism: "family-a",
    focus: {
      file: routeFaultsFocus,
      test: "a repository whose append() throws never propagates — warn carries the cause",
    },
    edits: [
      {
        file: routeFaults,
        before:
          "  try {\n    const written = repository?.append(`run:${runId}`, notice, ownership ?? undefined) ?? null;\n    return written !== null ? { recorded: true } : { recorded: false, cause: null };\n  } catch (error) {\n    return { recorded: false, cause: String(error) };\n  }",
        after:
          "  const written = repository?.append(`run:${runId}`, notice, ownership ?? undefined) ?? null;\n  return written !== null ? { recorded: true } : { recorded: false, cause: null };",
      },
    ],
  },
  // --- route-override.ts (#427, #446, #447) -------------------------------
  {
    id: "O1-max-route-pivots-per-run-widened",
    category: "max-route-pivots-per-run-widened",
    mechanism: "family-a",
    focus: {
      file: routeOverrideFocus,
      test: "a run pivots route at most 3 times — the 4th resume with 'route' is refused, naming the cap",
    },
    edits: [
      {
        file: routeOverride,
        before: "export const MAX_ROUTE_PIVOTS_PER_RUN = 3;",
        after: "export const MAX_ROUTE_PIVOTS_PER_RUN = 4;",
      },
    ],
  },
  {
    id: "O2-declares-route-missing-field",
    category: "declares-route-missing-field",
    mechanism: "family-a",
    focus: {
      file: routeOverrideFocus,
      test: "overrideNode also rewrites a pipeline stage that names its OWN route, not just the node's",
    },
    edits: [
      {
        file: routeOverride,
        before: 'const ROUTE_FIELDS = ["model", "tier", "effort", "provider"] as const;',
        after: 'const ROUTE_FIELDS = ["model", "tier", "effort"] as const;',
      },
    ],
  },
  {
    id: "O3-next-pivots-never-appends",
    category: "next-pivots-never-appends",
    mechanism: "family-a",
    focus: {
      file: routeOverrideFocus,
      test: "nextPivots appends only when an override is present; pivotsOf validates entries defensively",
    },
    edits: [
      {
        file: routeOverride,
        before:
          "export function nextPivots(\n  priorPivots: readonly RouteOverride[],\n  override: RouteOverride | undefined,\n): readonly RouteOverride[] {\n  return override === undefined ? priorPivots : [...priorPivots, override];\n}",
        after:
          "export function nextPivots(\n  priorPivots: readonly RouteOverride[],\n  override: RouteOverride | undefined,\n): readonly RouteOverride[] {\n  void override;\n  return priorPivots;\n}",
      },
    ],
  },
  {
    id: "O4-registration-payload-always-null",
    category: "registration-payload-always-null",
    mechanism: "family-a",
    focus: {
      file: routeOverrideFocus,
      test: "a crashed stretch's registration/progress writes carry 'pivots' forward — the 4th pivot stays refused after a fresh process resumes",
    },
    edits: [
      {
        file: routeOverride,
        before:
          "export function registrationPayload(\n  priorView: PriorPauseView | null,\n  options: Readonly<{ routeOverride?: RouteOverride }>,\n): string | null {\n  const pivots = nextPivots(priorView?.pivots ?? [], options.routeOverride);\n  return pivots.length === 0 ? null : JSON.stringify({ pivots });\n}",
        after:
          "export function registrationPayload(\n  priorView: PriorPauseView | null,\n  options: Readonly<{ routeOverride?: RouteOverride }>,\n): string | null {\n  void priorView;\n  void options;\n  return null;\n}",
      },
    ],
  },
  // #452 (M14, follow-up de #427 mergeado durante esta issue, PR #472):
  // `overrideNestedSpec` (route-override.ts) só existe porque `runNested`
  // (engine.ts) via um `ref` só resolvido em runtime, depois de #427's
  // `pivotResume` já ter rodado na spec EXTERNA — sem esta chamada, um
  // pivô de rota nunca alcança um template aninhado.
  {
    id: "O5-nested-route-override-not-applied",
    category: "nested-route-override-not-applied",
    mechanism: "family-a",
    focus: {
      file: routeOverrideNestedFocus,
      test: "WorkflowService.start → pause por route_fault na folha aninhada → resume com route completa o run; pivots com 1 entrada",
    },
    edits: [
      {
        file: engine,
        before:
          "const result = await nested.run(overrideNestedSpec(parsed, this.routeOverride), args);",
        after: "const result = await nested.run(parsed, args);",
      },
    ],
  },
  // --- orchestration/core.ts (#424, S1 per-leaf cap) ----------------------
  {
    id: "C1-max-pending-steers-per-leaf-widened",
    category: "max-pending-steers-per-leaf-widened",
    mechanism: "family-a",
    focus: {
      file: steerToolFocus,
      test: "propagates S1's steer_cap refusal (11th pending steer on the SAME busy leaf) as a named error, never queued:true (2ª emenda, #424)",
    },
    edits: [
      {
        file: orchestrationCore,
        before: "export const MAX_PENDING_STEERS_PER_LEAF = 10;",
        after: "export const MAX_PENDING_STEERS_PER_LEAF = 11;",
      },
    ],
  },
  // --- audit-runtime.ts (#423, #444) ---------------------------------------
  {
    id: "A1-leaf-steered-predicate-narrowed",
    category: "leaf-steered-predicate-narrowed",
    mechanism: "family-a",
    // `tests/workflow-audit-steered.test.ts`'s own steer_cap/null negative
    // tests never call `trail.flush()` before querying — the baseline
    // passes them because the ORIGINAL guard skips `record()` entirely (no
    // enqueue at all, so the missing flush never matters); under this
    // mutation `record()` DOES enqueue, but the write is async
    // (`AuditTrail.record` only enqueues — issue #423/#444's own doc
    // comment) and never becomes visible without a flush, so those two
    // tests still read back 0 events and the mutant would survive there.
    // `tests/workflow-steer-tool.test.ts`'s real-core steer_cap test DOES
    // flush before querying and is already a `focusFiles` entry of this
    // slice — a real kill, confirmed by running the mutation by hand.
    focus: {
      file: steerToolFocus,
      test: "propagates S1's steer_cap refusal (11th pending steer on the SAME busy leaf) as a named error, never queued:true (2ª emenda, #424)",
    },
    edits: [
      {
        file: auditRuntime,
        before:
          "    if (identity !== undefined && outcome !== null && outcome.refused === undefined) {",
        after: "    if (identity !== undefined) {",
      },
    ],
  },
  // --- orchestration/child-runner.ts (#429, dead_turn) --------------------
  {
    id: "D1-dead-turn-trim-removed",
    category: "dead-turn-trim-removed",
    mechanism: "family-a",
    focus: {
      file: delegateEnvelopeFocus,
      test: "names dead_turn when the final content is whitespace-only and no tool calls ran",
    },
    edits: [
      {
        file: childRunner,
        before:
          'const isDeadTurn = content.trim() === "" && (result.toolCalls?.length ?? 0) === 0;',
        after: 'const isDeadTurn = content === "" && (result.toolCalls?.length ?? 0) === 0;',
      },
    ],
  },
  {
    id: "D2-dead-turn-tool-calls-check-removed",
    category: "dead-turn-tool-calls-check-removed",
    mechanism: "family-a",
    focus: {
      file: delegateEnvelopeFocus,
      test: "keeps errorKind null when the final content is empty but the turn already executed a tool call",
    },
    edits: [
      {
        file: childRunner,
        before:
          'const isDeadTurn = content.trim() === "" && (result.toolCalls?.length ?? 0) === 0;',
        after: 'const isDeadTurn = content.trim() === "";',
      },
    ],
  },
  {
    id: "D3-dead-turn-relabeled-unknown",
    category: "dead-turn-relabeled-unknown",
    mechanism: "family-a",
    focus: {
      file: delegateEnvelopeFocus,
      test: "names a final turn with no text and no tool calls dead_turn, keeping status complete and output empty",
    },
    edits: [
      {
        file: childRunner,
        before: '          isDeadTurn ? "dead_turn" : null,',
        after: '          isDeadTurn ? "unknown" : null,',
      },
    ],
  },
  // --- transports/error-kinds.ts (#397, #429) ------------------------------
  {
    id: "E1-dead-turn-removed-from-vocabulary",
    category: "dead-turn-removed-from-vocabulary",
    mechanism: "family-a",
    focus: {
      file: transportErrorKindsFocus,
      test: "is the closed set from the épico #396 mapping",
    },
    edits: [
      {
        file: errorKinds,
        before: '  "context_length",\n  "unknown",\n  "dead_turn",\n] as const;',
        after: '  "context_length",\n  "unknown",\n] as const;',
      },
    ],
  },
];
