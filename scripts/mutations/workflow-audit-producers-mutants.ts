// Catálogo de 25 mutantes dos produtores novos do M7 (issue #370, 18): identidade
// causal (`audit-producers.ts`, #365), segmento/pausa/process_crash
// (`audit-producers.ts`, #368), folha e ferramenta (`audit-runtime.ts`,
// #366/#367), cache (`audit-cache.ts`, #368) e o ring do live tail
// (`live-tail.ts`, #369). Estende a fatia `workflow-audit-live` —
// `scripts/mutations/workflow-audit-live.ts` importa este catálogo junto
// com `workflow-audit-live-mutants.ts` (os 32 originais). Mesmo `Mutant`
// comum de `scripts/mutations/types.ts`, mesma mecânica A (git-archive +
// vitest focado) dos 32 originais.
//
// `category` deriva do `id` sem o prefixo `<letra><n>-`, mesma convenção do
// catálogo original. `focus.test` é o título literal do `it` (substring do
// `fullName`, veredito da PR #371/#362) — nunca um padrão de regex.
//
// Issue #383 (7 mutantes, 18 → 25): lacunas de oráculo o veredito da PR #382
// registrou (R6, L4, W1, M1) mais três emendas do orquestrador — a fiação do
// `AuditTrail` em `chat.ts` (W2, veredito da PR #384/#380), a allow-list de
// `event_type` ancorada na CHECAGEM, não no conteúdo (M1, #386), e o laço de
// flush do `close()` (T3, veredito da PR #385). Dois itens dessa mesma
// emenda (settle tardio, `pending.count` por `sub_id`) são só teste — sem
// mutante novo, pinados em `tests/workflow-audit-tool-cancel.test.ts`.
import type { Mutant } from "./types.js";

const auditProducers = "src/workflow/audit-producers.ts";
const auditRuntime = "src/workflow/audit-runtime.ts";
const auditCache = "src/workflow/audit-cache.ts";
const liveTail = "src/workflow/live-tail.ts";
const auditModel = "src/workflow/audit-model.ts";
const workflowCommand = "src/commands/workflow.ts";
const workflowTool = "src/workflow/tool.ts";
const chatCommand = "src/commands/chat.ts";

const identityFocus = "tests/workflow-audit-identity.test.ts";
const segmentFocus = "tests/workflow-audit-segment.test.ts";
const leafFocus = "tests/workflow-audit-leaf.test.ts";
const toolFocus = "tests/workflow-audit-tool.test.ts";
const cacheFocus = "tests/workflow-audit-cache.test.ts";
const liveTailFocus = "tests/workflow-live-tail.test.ts";
const watchEventsFocus = "tests/workflow-watch-events.test.ts";
const allowListFocus = "tests/workflow-audit-allow-list.test.ts";
const chatAuditWiringFocus = "tests/chat-audit-trail-wiring.test.ts";

export const auditProducersMutants: readonly Mutant[] = [
  {
    id: "P1-segment-id-dropped",
    category: "segment-id-dropped",
    mechanism: "family-a",
    focus: {
      file: identityFocus,
      test: "every event of a durable run carries the SAME segment_id the durable line publishes",
    },
    edits: [
      {
        file: auditProducers,
        before: "      segment_id: segmentId,\n    });\n  }",
        after: "    });\n  }",
      },
    ],
  },
  {
    id: "P2-fail-closed-disabled",
    category: "fail-closed-disabled",
    mechanism: "family-a",
    focus: {
      file: identityFocus,
      test: "fail-closed: an event produced after this stretch is EVICTED from the bounded fence memory never reaches the ledger, fenced or not — a warn names the drop",
    },
    edits: [
      {
        file: auditProducers,
        before: "  if (durable && ownership === null) {",
        after: "  if (false && ownership === null) {",
      },
    ],
  },
  {
    id: "P3-segment-started-after-plan",
    category: "segment-started-after-plan",
    mechanism: "family-a",
    focus: {
      file: segmentFocus,
      test: "segment.started is the FIRST event of a stretch, segment.completed the LAST before workflow.done, same segment_id",
    },
    edits: [
      {
        file: auditProducers,
        before: "    announceSegmentStarted(attempt);\n    announcePlan(spec, budget);",
        after: "    announcePlan(spec, budget);\n    announceSegmentStarted(attempt);",
      },
    ],
  },
  {
    id: "P4-crash-as-sink-failure",
    category: "crash-as-sink-failure",
    mechanism: "family-a",
    focus: {
      file: identityFocus,
      test: "a dead-owner resume closes the PRIOR segment as interrupted/process_crash and records an audit.gap, under the NEW fence — a paused (checkpoint) resume records neither",
    },
    edits: [
      {
        file: auditProducers,
        before: '      payload: { status: "interrupted", reason: "process_crash" },',
        after: '      payload: { status: "interrupted", reason: "sink_failure" },',
      },
    ],
  },
  {
    id: "P5-gap-before-crash-close",
    category: "gap-before-crash-close",
    mechanism: "family-a",
    focus: {
      file: segmentFocus,
      test: "a dead-owner (orphaned) resume closes the PRIOR segment as interrupted/process_crash, then audit.gap{process_crash}, both under the NEW fence, before segment.started",
    },
    edits: [
      {
        file: auditProducers,
        before:
          '    recordAuditEvent(failClosed, runId, {\n      event_type: "segment.completed",\n      ...(priorSegmentId === null ? {} : { segment_id: priorSegmentId }),\n      payload: { status: "interrupted", reason: "process_crash" },\n    });\n    recordAuditEvent(failClosed, runId, {\n      event_type: "audit.gap",\n      payload: { reason: "process_crash", count_state: "unavailable" },\n    });',
        after:
          '    recordAuditEvent(failClosed, runId, {\n      event_type: "audit.gap",\n      payload: { reason: "process_crash", count_state: "unavailable" },\n    });\n    recordAuditEvent(failClosed, runId, {\n      event_type: "segment.completed",\n      ...(priorSegmentId === null ? {} : { segment_id: priorSegmentId }),\n      payload: { status: "interrupted", reason: "process_crash" },\n    });',
      },
    ],
  },
  {
    id: "P6-flush-before-release-skipped",
    category: "flush-before-release-skipped",
    mechanism: "family-a",
    focus: {
      file: identityFocus,
      test: "a durable run's terminal write (workflow.done, segment.completed) actually reaches the ledger",
    },
    edits: [
      {
        file: auditProducers,
        before: "    const ok = await trail.flush();",
        after: "    const ok = true;",
      },
    ],
  },
  {
    id: "L1-terminal-twice",
    category: "terminal-twice",
    mechanism: "family-a",
    focus: {
      file: leafFocus,
      test: "schema retry (steer + second collect on the SAME id) produces only ONE started and ONE terminal",
    },
    edits: [
      {
        file: auditRuntime,
        before: "    open.delete(id);\n    const cc = leaf.causal;",
        after: "    const cc = leaf.causal;",
      },
    ],
  },
  {
    id: "L2-timeout-as-cancelled",
    category: "timeout-as-cancelled",
    mechanism: "family-a",
    focus: {
      file: leafFocus,
      test: "a leaf timeout (wait:true collect returning running) closes ONCE as interrupted/timeout — the engine's follow-up cancel() adds nothing",
    },
    edits: [
      {
        file: auditRuntime,
        before: '          reason: "timeout",',
        after: '          reason: "cancelled",',
      },
    ],
  },
  {
    id: "L3-nested-path-flattened",
    category: "nested-path-flattened",
    mechanism: "family-a",
    focus: {
      file: leafFocus,
      test: "a nested workflow's leaf shares the parent's segment_id and comes out with a scoped node_path",
    },
    edits: [
      {
        file: auditRuntime,
        before: "          node_path: cc.nodePath,",
        after: '          node_path: [cc.nodePath.at(-1) ?? ""],',
      },
    ],
  },
  {
    id: "T1-tool-without-subid",
    category: "tool-without-subid",
    mechanism: "family-a",
    focus: {
      file: toolFocus,
      test: 'a call the sandbox lets through: tool.started then tool.completed{status:"success"} from onToolSettled; a call it denies: tool.completed{status:"error", reason:"sandbox_denied"} right after tool.started, no onToolSettled needed',
    },
    edits: [
      {
        file: auditRuntime,
        before:
          "    const identity = {\n      segment_id: cc.segmentId,\n      node_id: cc.nodePath.at(-1) ?? null,\n      sub_id: leaf.subId,\n      attempt: cc.attempt,\n    };",
        after:
          "    const identity = {\n      segment_id: cc.segmentId,\n      node_id: cc.nodePath.at(-1) ?? null,\n      attempt: cc.attempt,\n    };",
      },
    ],
  },
  {
    id: "T2-denial-as-success",
    category: "denial-as-success",
    mechanism: "family-a",
    focus: {
      file: toolFocus,
      test: 'a call the sandbox lets through: tool.started then tool.completed{status:"success"} from onToolSettled; a call it denies: tool.completed{status:"error", reason:"sandbox_denied"} right after tool.started, no onToolSettled needed',
    },
    edits: [
      {
        file: auditRuntime,
        before: '        payload: { status: "error", reason: "sandbox_denied" },',
        after: '        payload: { status: "success" },',
      },
    ],
  },
  {
    id: "C1-hit-as-miss",
    category: "hit-as-miss",
    mechanism: "family-a",
    focus: {
      file: cacheFocus,
      test: "miss then stored on the first run; replayed (with usage) on a resume — same node_id, same segment_id per stretch",
    },
    edits: [
      {
        file: auditCache,
        before: '        lookup.hit ? "cache.replayed" : "cache.missed",',
        after: '        "cache.missed",',
      },
    ],
  },
  {
    id: "C2-refused-as-stored",
    category: "refused-as-stored",
    mechanism: "family-a",
    focus: {
      file: cacheFocus,
      test: "put refused (fence obsolete) records cache.unavailable{reason:store_failed}, never a silent drop",
    },
    edits: [
      {
        file: auditCache,
        before: '        ok ? "cache.stored" : "cache.unavailable",',
        after: '        "cache.stored",',
      },
    ],
  },
  {
    id: "R1-bytes-cap-ignored",
    category: "bytes-cap-ignored",
    mechanism: "family-a",
    focus: {
      file: liveTailFocus,
      test: "a single event bigger than the whole byte cap is dropped, never stored, push still succeeds",
    },
    edits: [
      {
        file: liveTail,
        before: "    if (bytes > LIVE_TAIL_BYTES) {",
        after: "    if (false) {",
      },
    ],
  },
  {
    id: "R2-byte-trim-disabled",
    category: "byte-trim-disabled",
    mechanism: "family-a",
    focus: {
      file: liveTailFocus,
      test: "evicts by serialized bytes before the event count ever reaches the cap",
    },
    edits: [
      {
        file: liveTail,
        before:
          "(ring.events.length >= LIVE_TAIL_EVENTS || ring.totalBytes + bytes > LIVE_TAIL_BYTES)",
        after: "(ring.events.length >= LIVE_TAIL_EVENTS || false)",
      },
    ],
  },
  {
    id: "R3-dropped-not-counted",
    category: "dropped-not-counted",
    mechanism: "family-a",
    focus: {
      file: liveTailFocus,
      test: "keeps at most LIVE_TAIL_EVENTS and reports dropped once the cap is crossed; another run is unaffected",
    },
    edits: [
      {
        file: liveTail,
        before:
          "      const removed = ring.events.shift();\n      if (removed !== undefined) {\n        ring.totalBytes -= removed.bytes;\n        counters.dropped += 1;\n      }",
        after:
          "      const removed = ring.events.shift();\n      if (removed !== undefined) {\n        ring.totalBytes -= removed.bytes;\n      }",
      },
    ],
  },
  {
    id: "R4-caps-evicts-live-run",
    category: "caps-evicts-live-run",
    mechanism: "family-a",
    focus: {
      file: liveTailFocus,
      test: "never evicts a live run to make room — with every tracked run still live, the map is left to grow",
    },
    edits: [
      {
        file: liveTail,
        before: "      if (!this.rings.has(id)) {",
        after: "      if (true) {",
      },
    ],
  },
  {
    id: "R5-forget-regresses-cursor",
    category: "forget-regresses-cursor",
    mechanism: "family-a",
    focus: {
      file: liveTailFocus,
      test: "forget(runId) clears a ring directly, but leaves next/dropped intact",
    },
    edits: [
      {
        file: liveTail,
        before: "    this.rings.delete(runId);",
        after: "    this.rings.delete(runId);\n    this.runs.delete(runId);",
      },
    ],
  },
  // Issue #383, item 1 (veredito da PR #382): the ring's evict-oldest
  // guarantee (FIFO) had no test — `R2-drop-newest` (`shift()` → `pop()`)
  // survived the first real corridor and was swapped for `R2-byte-trim-
  // disabled`. A dedicated FIFO test closes that gap.
  {
    id: "R6-drop-newest",
    category: "drop-newest",
    mechanism: "family-a",
    focus: {
      file: liveTailFocus,
      test: "evicts the OLDEST event first (FIFO) — the first surviving event is exactly the k-th pushed",
    },
    edits: [
      {
        file: liveTail,
        before: "      const removed = ring.events.shift();",
        after: "      const removed = ring.events.pop();",
      },
    ],
  },
  // Issue #383, item 2 (veredito da PR #382): `collect()`'s `wait:false`
  // branch (a non-terminal ChildResult with the caller NOT waiting) had no
  // test — a mutant that always closes the leaf regardless of `wait` would
  // have survived.
  {
    id: "L4-wait-false-closes",
    category: "wait-false-closes",
    mechanism: "family-a",
    focus: {
      file: leafFocus,
      test: "collect wait:false returning running emits no terminal — only a later done/cancel closes the leaf",
    },
    edits: [
      {
        file: auditRuntime,
        before: "      } else if (options.wait) {",
        after: "      } else if (true) {",
      },
    ],
  },
  // Issue #383, item 3 (veredito da PR #382): `watch --events`'s cursor had
  // no mutant — killed by the EXISTING poll test
  // (`tests/workflow-watch-events.test.ts:113`), added to this slice's
  // `focusFiles` for the first time here.
  {
    id: "W1-watch-events-repeat",
    category: "watch-events-repeat",
    mechanism: "family-a",
    focus: {
      file: watchEventsFocus,
      test: "advances the cursor across polls without re-showing an already-printed event",
    },
    edits: [
      {
        file: workflowCommand,
        before: "    if (page.page.has_more !== true) return after;",
        after: "    if (page.page.has_more !== true) return cursor;",
      },
    ],
  },
  // Issue #383, item 4 (veredito da PR #382, emenda #386): the allow-list
  // CHECK itself (never the `SAFE_EVENT_TYPES` set's contents, #386's own
  // concern) had no mutant — killed by the existing #386 regression test.
  {
    id: "M1-allowlist-free-string",
    category: "allowlist-free-string",
    mechanism: "family-a",
    focus: {
      file: allowListFocus,
      test: "treats a removed node.* type as unknown, not as a valid event_type",
    },
    edits: [
      {
        file: auditModel,
        before:
          'const eventType = SAFE_EVENT_TYPES.has(input.event_type) ? input.event_type : "audit.unavailable";',
        after: "const eventType = input.event_type;",
      },
    ],
  },
  // Issue #383, item 5 (emenda do orquestrador, veredito da PR #384/#380);
  // re-ancorado na issue #401 (M8-5): `chat.ts`'s own `AuditTrail` — a
  // sink_failure on its very first audit write, if the
  // `{ warning: sessionToolBase.noticesSink.warn }` wiring were ever
  // dropped, would silently vanish instead of reaching `console.warn`.
  // #401 unified the old ad hoc `auditWarning` closure into the ONE
  // notices sink `createSessionToolBase` builds — `noticesSink.warn`
  // still calls `console.warn` as its fallback (never a second line on
  // stderr), so this mutant's kill signal is unchanged.
  {
    id: "W2-audit-trail-warning-unwired",
    category: "audit-trail-warning-unwired",
    mechanism: "family-a",
    focus: {
      file: chatAuditWiringFocus,
      test: "a sink_failure on the run's first audit write reaches console.warn via chat.ts's AuditTrail sink",
    },
    edits: [
      {
        file: chatCommand,
        before:
          "auditTrail: new AuditTrail(sessionToolBase.auditRepository, {\n" +
          "      warning: sessionToolBase.noticesSink.warn,\n" +
          "    }),",
        after: "auditTrail: new AuditTrail(sessionToolBase.auditRepository),",
      },
    ],
  },
  // Issue #383, item 8 (emenda do orquestrador, veredito da PR #385):
  // `close()`'s flush loop for a leaf's still-open tool dispatches — killed
  // by the existing "cancel with a dispatch still pending" test (#378/#385).
  {
    id: "T3-cancel-flush-skipped",
    category: "cancel-flush-skipped",
    mechanism: "family-a",
    focus: {
      file: toolFocus,
      test: 'cancel with a dispatch still pending: tool.completed{status:"error",reason:"cancelled"} closes the orphan BEFORE leaf.failed',
    },
    edits: [
      {
        file: auditRuntime,
        before: "    for (let index = 0; index < leaf.pending.count; index += 1) {",
        after: "    for (let index = 0; index < 0; index += 1) {",
      },
    ],
  },
  // Issue #383, item 9 (emenda do orquestrador): `workflow_audit`'s own
  // `pending` report (issue #373, PR #389) — killed by the existing stuck-
  // sink test.
  {
    id: "PD-pending-never-reported",
    category: "pending-never-reported",
    mechanism: "family-a",
    focus: {
      file: toolFocus,
      test: "a drain stuck on a permanently-busy sink reports integrity.pending instead of a silent events: []",
    },
    edits: [
      {
        file: workflowTool,
        before: "  if (pending <= 0) return toolResult(undefined, page);",
        after: "  if (true) return toolResult(undefined, page);",
      },
    ],
  },
];
