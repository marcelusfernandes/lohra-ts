// Catálogo de mutantes dos produtores novos do M7 (issue #370): identidade
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
import type { Mutant } from "./types.js";

const auditProducers = "src/workflow/audit-producers.ts";
const auditRuntime = "src/workflow/audit-runtime.ts";
const auditCache = "src/workflow/audit-cache.ts";
const liveTail = "src/workflow/live-tail.ts";

const identityFocus = "tests/workflow-audit-identity.test.ts";
const segmentFocus = "tests/workflow-audit-segment.test.ts";
const leafFocus = "tests/workflow-audit-leaf.test.ts";
const toolFocus = "tests/workflow-audit-tool.test.ts";
const cacheFocus = "tests/workflow-audit-cache.test.ts";
const liveTailFocus = "tests/workflow-live-tail.test.ts";

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
];
