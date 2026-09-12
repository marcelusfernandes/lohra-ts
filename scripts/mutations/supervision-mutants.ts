// Catálogo de 29 mutantes da fatia `supervision` (issue #451, milestone 14 —
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
// Issue #484 (milestone 15, achado dos vereditos das PRs #478/#482)
// acrescenta 9 mutantes: 6 para `src/workflow/cache-preview.ts` (#462) e 3
// para `src/workflow/templates.ts` (#464) — nenhum dos dois tinha mutante em
// catálogo nenhum, apesar de `srcGlobs: ["src/workflow/**", ...]` já cobrir
// os dois (não precisou de `srcGlobs` novo, só `focusFiles`).
//
// Rodada 2 (veredito da PR #497, revisor): a rodada 1 desta issue tinha
// deixado de fora o mutante de `put()` que a issue original pedia, com uma
// justificativa FALSA ("código morto em toda execução de preview" — o
// argumento de que `DryRuntime.collect` sempre falha, então
// `collectLeaf`/`cachePut` nunca alcançam `put()`). O revisor reproduziu o
// contrário: `engine.ts:480`'s `runParallel` chama `cache.put(...)`
// INCONDICIONALMENTE quando `branches` resolve para `[]` — `[].every(nonEmpty)`
// é vacuamente `true`, sem nenhum leaf spawnado, dry ou real (`schema.ts`
// aceita `branches: []`; `budget.ts`'s `checkFanout(0)` nunca lança). P6
// (abaixo) cobre esse caminho, ancorado em
// `tests/workflow-cache-preview-writes.test.ts` (arquivo novo — a suíte
// principal está no teto de 800 linhas; issue #484 emendada com esse glob).
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
const cachePreview = "src/workflow/cache-preview.ts";
const templates = "src/workflow/templates.ts";
const cachePreviewFocus = "tests/workflow-cache-preview.test.ts";
const cachePreviewWritesFocus = "tests/workflow-cache-preview-writes.test.ts";
const templatesFocus = "tests/workflow-templates.test.ts";
const transportsClient = "src/transports/client.ts";
const orchestrationRuntime = "src/workflow/orchestration-runtime.ts";
const abortInFlightFocus = "tests/transports-abort-in-flight.test.ts";
const childRunnerAbortFocus = "tests/orchestration-child-runner-abort.test.ts";
const workflowOrchestrationRuntimeTimeoutFocus =
  "tests/workflow-orchestration-runtime-timeout.test.ts";
const validation = "src/orchestration/validation.ts";
const orchestrationToolsFocus = "tests/orchestration-tools.test.ts";

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
        // Re-anchored by issue #459 (M11-S1, épico #458): the `before` below
        // is `isRouteLesson`'s body AFTER #459 grew `suggested_route` from
        // the literal `null` to `Route | null` — the last clause changed
        // from `candidate.suggested_route === null` to accept the filled
        // shape too (`isRoute(candidate.suggested_route)`). Amendment on
        // issue #459 (2026-09-13) put this catalog in that issue's `Files`
        // for exactly this re-anchor.
        file: routeFaults,
        before:
          'export function isRouteLesson(value: unknown): value is RouteLesson {\n  if (value === null || typeof value !== "object") return false;\n  const candidate = value as Readonly<Record<string, unknown>>;\n  return (\n    typeof candidate.error_kind === "string" &&\n    isRouteFault(candidate.error_kind as ErrorKind) &&\n    typeof candidate.node_id === "string" &&\n    (candidate.provider === null || typeof candidate.provider === "string") &&\n    (candidate.model === null || typeof candidate.model === "string") &&\n    (candidate.suggested_route === null || isRoute(candidate.suggested_route))\n  );\n}',
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
  // --- cache-preview.ts (#462, issue #484) --------------------------------
  {
    id: "P1-pivots-used-off-by-one",
    category: "pivots-used-off-by-one",
    mechanism: "family-a",
    focus: {
      file: cachePreviewFocus,
      test: "replays the unpinned cell, reports the pinned one as recompute/never_completed, and writes nothing",
    },
    edits: [
      {
        file: cachePreview,
        before: "    pivots_used: view.pivots.length,",
        after: "    pivots_used: view.pivots.length + 1,",
      },
    ],
  },
  {
    id: "P2-route-applied-inverted",
    category: "route-applied-inverted",
    mechanism: "family-a",
    focus: {
      file: cachePreviewFocus,
      test: "with 'route' applied, still writes nothing and does not consume a pivot",
    },
    edits: [
      {
        file: cachePreview,
        before: "    route_applied: deps.route !== undefined,",
        after: "    route_applied: deps.route === undefined,",
      },
    ],
  },
  {
    id: "P3-recompute-mislabeled-replay",
    category: "recompute-mislabeled-replay",
    mechanism: "family-a",
    focus: {
      file: cachePreviewFocus,
      test: "replays the unpinned cell, reports the pinned one as recompute/never_completed, and writes nothing",
    },
    edits: [
      {
        file: cachePreview,
        before: '    return { node_id: node.id, type: node.type, outcome: "recompute", reason };',
        after: '    return { node_id: node.id, type: node.type, outcome: "replay", reason };',
      },
    ],
  },
  {
    id: "P4-nested-classification-guard-narrowed",
    category: "nested-classification-guard-narrowed",
    mechanism: "family-a",
    focus: {
      file: cachePreviewFocus,
      test: "with a loader, aggregates the nested cells it already has as 'nested'",
    },
    edits: [
      {
        file: cachePreview,
        before:
          '  if (node.type === "workflow" && ((hits?.count ?? 0) > 0 || (spawns?.count ?? 0) > 0)) {',
        after:
          '  if (node.type === "workflow" && ((hits?.count ?? 0) > 0 && (spawns?.count ?? 0) > 0)) {',
      },
    ],
  },
  {
    id: "P5-leaves-to-spawn-counts-owners-not-spawns",
    category: "leaves-to-spawn-counts-owners-not-spawns",
    mechanism: "family-a",
    focus: {
      file: cachePreviewFocus,
      test: "a parallel node with no successful branch re-spawns exactly one leaf per branch",
    },
    edits: [
      {
        file: cachePreview,
        before: "  const leavesToSpawn = runtime.spawns.length;",
        after: "  const leavesToSpawn = spawnsByOwner.size;",
      },
    ],
  },
  // Rodada 2 (veredito da PR #497): o mutante que a issue #484 original
  // pedia e a rodada 1 tinha, incorretamente, descartado como "código
  // morto" — `runParallel` (engine.ts:480) chama `cache.put(...)` mesmo sem
  // spawnar nenhum leaf quando `branches` resolve para `[]`. Há uma segunda
  // barreira independente (`previewResume`'s `dummyOwnership` de
  // `fence: -1`, recusada por `ownershipGuard`), por isso o oráculo em
  // `tests/workflow-cache-preview-writes.test.ts` conta tentativas de
  // `putCacheCellWithCost`, não só linhas de `workflow_node_cache`.
  {
    id: "P6-put-facade-delegates-to-real-cache",
    category: "put-facade-delegates-to-real-cache",
    mechanism: "family-a",
    focus: {
      file: cachePreviewWritesFocus,
      test: "a parallel node with empty branches writes nothing to workflow_node_cache during preview",
    },
    edits: [
      {
        file: cachePreview,
        before: "  put(): boolean {\n    return false;\n  }",
        after:
          "  put(runId: string, hash: string, nodeId: string, output: unknown, cost: unknown): boolean {\n    return this.real.put(runId, hash, nodeId, output, cost as never);\n  }",
      },
    ],
  },
  // --- templates.ts (#464, issue #484) ------------------------------------
  {
    id: "T1-template-ref-accepts-path-separator",
    category: "template-ref-accepts-path-separator",
    mechanism: "family-a",
    focus: {
      file: templatesFocus,
      test: "refuses a ref with an internal path separator (a/b)",
    },
    edits: [
      {
        file: templates,
        before: "export const TEMPLATE_REF = /^[a-z0-9][a-z0-9_-]{0,63}$/;",
        after: "export const TEMPLATE_REF = /^[a-z0-9][a-z0-9_/-]{0,63}$/;",
      },
    ],
  },
  {
    id: "T2-list-templates-drops-broken-file",
    category: "list-templates-drops-broken-file",
    mechanism: "family-a",
    focus: {
      file: templatesFocus,
      test: "lists a valid template and never drops a broken one",
    },
    edits: [
      {
        file: templates,
        before:
          "    } catch (error) {\n      entries.push({ ref, error: error instanceof Error ? error.message : String(error) });\n    }",
        after: "    } catch {\n      continue;\n    }",
      },
    ],
  },
  {
    id: "T3-read-template-file-swallows-enoent",
    category: "read-template-file-swallows-enoent",
    mechanism: "family-a",
    focus: {
      file: templatesFocus,
      test: "throws a named error citing the path for an absent ref",
    },
    edits: [
      {
        file: templates,
        before:
          '    content = readFileSync(path, "utf8");\n  } catch (error) {\n    throw new TemplateError(\n      ref,\n      isEnoent(error) ? `not found at ${path}` : `at ${path} could not be read`,\n      error,\n    );\n  }',
        after:
          '    content = readFileSync(path, "utf8");\n  } catch (error) {\n    if (isEnoent(error)) return {};\n    throw new TemplateError(ref, `at ${path} could not be read`, error);\n  }',
      },
    ],
  },
  // Issue #502 (non_blocking 4, PR #497): `estimated_tokens_to_repay`/
  // `estimate_basis` (`:388-390`) had no mutant at all in this catalog —
  // P1-P6 above never touch this pair. Both anchored on the SAME new `it`
  // in `tests/workflow-cache-preview-writes.test.ts`, which plants
  // `workflow_node_cost` rows directly so the averaged value is fractional
  // (30.5) — a dropped `Math.round` and a hardcoded `null` basis are two
  // independent bugs a single scalar oracle on either field alone would not
  // both catch.
  {
    id: "P7-estimated-tokens-to-repay-drops-rounding",
    category: "estimated-tokens-to-repay-drops-rounding",
    mechanism: "family-a",
    focus: {
      file: cachePreviewWritesFocus,
      test: "averages workflow_node_cost across the run and rounds leavesToSpawn * average exactly",
    },
    edits: [
      {
        file: cachePreview,
        before:
          "  const estimatedTokensToRepay = average === null ? null : Math.round(leavesToSpawn * average);",
        after:
          "  const estimatedTokensToRepay = average === null ? null : leavesToSpawn * average;",
      },
    ],
  },
  {
    id: "P8-estimate-basis-always-null",
    category: "estimate-basis-always-null",
    mechanism: "family-a",
    focus: {
      file: cachePreviewWritesFocus,
      test: "averages workflow_node_cost across the run and rounds leavesToSpawn * average exactly",
    },
    edits: [
      {
        file: cachePreview,
        before:
          '  const estimateBasis: "measured_average" | null = average === null ? null : "measured_average";',
        after: '  const estimateBasis: "measured_average" | null = null;',
      },
    ],
  },
  // Issue #503 (follow-up of #484 rodada 2, PR #497 veredito non_blocking
  // 4): `classifyNode` used to fall through to `unknown` for a `parallel`
  // node whose dry run ran to completion with zero spawns and zero hits
  // (`branches: []`, the exact case P6 above already proves reaches
  // `cache.put(...)`) — mixing "not modeled" with "ran, nothing to pay".
  // This mutant reverts the new `no_leaves` outcome back to `unknown`,
  // killed by the same `tests/workflow-cache-preview-writes.test.ts` file.
  {
    id: "P9-no-leaves-mislabeled-unknown",
    category: "no-leaves-mislabeled-unknown",
    mechanism: "family-a",
    focus: {
      file: cachePreviewWritesFocus,
      test: "a parallel node with empty branches classifies as no_leaves, not unknown",
    },
    edits: [
      {
        file: cachePreview,
        before: '    return { node_id: node.id, type: node.type, outcome: "no_leaves" };',
        after: '    return { node_id: node.id, type: node.type, outcome: "unknown" };',
      },
    ],
  },
  // Issue #515 (follow-up of #503, veredito da PR #510): `no_leaves`
  // (P9 above) used to fire for ANY `parallel` with zero spawns/zero hits,
  // conflating "branches resolved to `[]`, nothing to pay" with two
  // genuinely blocked cases — `branches` that never resolved to an array at
  // all (a template over a failed upstream) and a fan-out cap trip
  // (`FanoutRejected`) — both leave `output === null`, never `[]`. This
  // mutant drops the new `Array.isArray(output) && output.length === 0`
  // guard, reverting to "any parallel that ran with nothing spawned/hit is
  // no_leaves" — killed by the fan-out-cap `it` below, which needs
  // `unknown`, not `no_leaves`, for exactly that `null` case.
  {
    id: "P10-no-leaves-guard-drops-empty-array-check",
    category: "no-leaves-guard-drops-empty-array-check",
    mechanism: "family-a",
    focus: {
      file: cachePreviewWritesFocus,
      test: "a parallel node above the fan-out cap reports unknown, never no_leaves",
    },
    edits: [
      {
        file: cachePreview,
        before: '  if (node.type === "parallel" && Array.isArray(output) && output.length === 0) {',
        after: '  if (node.type === "parallel") {',
      },
    ],
  },
  // --- abort em voo (M16, épico #490, issue #519) -------------------------
  // Issue #519 (M16-S4, última sub-issue da milestone): S1-S3/S5/S6 já
  // mergearam o caminho de abort em voo (ADR 0005) sem nenhum mutante
  // cobrindo `stream()`'s própria propagação de `signal`, a reclassificação
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
          "    let response: HttpResponseData;\n    try {\n      response = await this.request({ ...kwargs, stream: true }, signal);\n    } catch (error) {\n      rethrowAborted(error, (partialBody) => {\n        const chunks = parseSse(partialBody, parseJsonPreservingNumbers);",
        after:
          "    let response: HttpResponseData;\n    try {\n      response = await this.request({ ...kwargs, stream: true });\n    } catch (error) {\n      rethrowAborted(error, (partialBody) => {\n        const chunks = parseSse(partialBody, parseJsonPreservingNumbers);",
      },
    ],
  },
  {
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
        before:
          '            ...zeroResult("interrupted", "", profile, model, error.partialUsage, "cancelled", null),',
        after:
          '            ...zeroResult("interrupted", "", profile, model, null, "cancelled", null),',
      },
    ],
  },
  // N3 originally targeted `CANCEL_SETTLE_TIMEOUT_MS = 0` (issue #519's own
  // suggestion) against `tests/workflow-abort-in-flight.test.ts`'s "resolves
  // once the leaf actually settles" test — verified NOT to kill: that test's
  // own settlement chain resolves entirely via microtasks (no real timer or
  // I/O in between `core.cancel()` and the leaf's teardown), so Node drains
  // it before ANY `setTimeout`, including one scheduled for 0ms, ever fires
  // — the race never actually reaches the ceiling. Retargeted at #521
  // (M16-S6)'s sibling ceiling in the SAME function family — `collect()`'s
  // own `deadlineMs` — against a focus that uses a genuinely stuck leaf (a
  // promise that never resolves at all), where the ceiling is the ONLY
  // thing that can ever settle the race.
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
  // --- validation.ts (#540, achado 5) -------------------------------------
  // Issue #540: nenhum catálogo de mutação cobria `normalizeResumeId`
  // (`src/orchestration/validation.ts`) — a única garantia era
  // `tests/orchestration-tools.test.ts` (PR #523, QA de 87b9aeac). Off-by-one
  // no comprimento aparado: `""` (0 chars) some do isAbsent check com o
  // mutante (compara contra 1, nunca 0), então `resume_id` deixa de ser
  // removido para uma string vazia/whitespace-only — morto pelo `it` que já
  // prova exatamente essa forma.
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
];
