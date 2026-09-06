// Catálogo de mutantes de `src/workflow/audit-*` e vizinhos (issue #150,
// passo 13-S3 do épico #13). Migrado do antigo runner de mutação de
// workflow-audit-live no diretório histórico de paridade (32 mutantes,
// mecânica A: git-archive + vitest focado) para o `Mutant` comum de
// `scripts/mutations/types.ts`. `category` deriva de `cause` do arquivo
// original (sempre `MUTATION_CAUSE:${id}`, então a categoria é o `id` sem o
// prefixo `M<n>-`); `mechanism` é sempre `"family-a"` — o harness comum
// ainda não cobre a mecânica B (probe externo em processo separado), então
// os `externalCause` do arquivo original (checagem extra via um probe
// externo, fora de escopo desta issue) não são reproduzidos aqui: o
// oráculo de cada mutante já era, no mínimo, o teste focado falhar
// (`test.status !== 0` era condição obrigatória no `killed` original),
// então a mecânica A sozinha continua suficiente para matar os 32.
//
// Nenhum símbolo aqui depende de I/O; só dados.
import type { Mutant } from "./types.js";

const auditModel = "src/workflow/audit-model.ts";
const auditTrail = "src/workflow/audit-trail.ts";
const repository = "src/state/audit-repository.ts";
const live = "src/workflow/live-events.ts";
const argSpec = "src/cli/arg-spec.ts";
const cli = "src/cli.ts";
const service = "src/workflow/service.ts";
const chat = "src/commands/chat.ts";
const focusFile = "tests/workflow-audit-live.test.ts";

export const mutants: readonly Mutant[] = [
  {
    id: "M1-canary-leak",
    category: "canary-leak",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "redacts every private raw field without leaking a unicode canary",
    },
    edits: [
      {
        file: auditModel,
        before:
          "function safeValue(value: unknown, key: string, depth: number): unknown {\n  if (RAW_FIELDS.has(key)) {",
        after:
          'function safeValue(value: unknown, key: string, depth: number): unknown {\n  if (key === "prompt") return value;\n  if (RAW_FIELDS.has(key)) {',
      },
    ],
  },
  {
    id: "M2-character-cap",
    category: "character-cap",
    mechanism: "family-a",
    focus: { file: focusFile, test: "caps public events by serialized UTF-8 bytes" },
    edits: [
      {
        file: auditModel,
        before: 'return Buffer.byteLength(JSON.stringify(value), "utf8");',
        after: "return JSON.stringify(value).length;",
      },
    ],
  },
  {
    id: "M3-silent-overflow",
    category: "silent-overflow",
    mechanism: "family-a",
    focus: { file: focusFile, test: "turns queue overflow into an explicit gap" },
    edits: [
      {
        file: auditTrail,
        before:
          '      this.markDropped(order, runId, "queue_overflow", ownership);\n      this.warning(`audit queue overflow for run ${runId}`);',
        after: "      this.warning(`audit queue overflow for run ${runId}`);",
      },
    ],
  },
  {
    id: "M4-moving-snapshot",
    category: "moving-snapshot",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "allocates dense seq, freezes snapshots and keeps run-wide integrity notices",
    },
    edits: [
      {
        file: repository,
        before: "Math.trunc(query.snapshotSeq ?? currentHigh)",
        after: "Math.trunc(currentHigh)",
      },
    ],
  },
  {
    id: "M5-nontransactional-seq",
    category: "nontransactional-seq",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "rolls back sequence allocation when the event insert fails",
    },
    edits: [
      {
        file: repository,
        before:
          "const transact = this.database\n      .transaction((): PublicAuditEvent | null => {",
        after: "const transact = ((): PublicAuditEvent | null => {",
      },
      {
        file: repository,
        before: "      })\n      .immediate();\n    if (transact === null",
        after: "    })();\n    if (transact === null",
      },
    ],
  },
  {
    id: "M6-fence-ignored",
    category: "fence-ignored",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "rejects a stale fence inside the append transaction without reserving seq",
    },
    edits: [
      {
        file: repository,
        before: "WHERE f.run_id = ? AND f.fence = ? AND l.holder = ? AND l.expires_at > ?",
        after: "WHERE f.run_id = ? AND ? IS NOT NULL AND l.holder = ? AND l.expires_at > ?",
      },
    ],
  },
  {
    id: "M7-global-throttle",
    category: "global-throttle",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "throttles per run/node, preserves first/last, and retains a throwing observer",
    },
    edits: [
      {
        file: live,
        before: 'const key = `${snapshot.run_id}\\u0000${snapshot.node_id ?? ""}`;',
        after: "const key = `${snapshot.run_id}\\u0000global`;",
      },
    ],
  },
  {
    id: "M8-last-suppressed",
    category: "last-suppressed",
    mechanism: "family-a",
    focus: { file: focusFile, test: "never suppresses the last item width" },
    edits: [
      {
        file: live,
        before: "(snapshot.done ?? 0) >= snapshot.total",
        after: "(snapshot.done ?? 0) > snapshot.total",
      },
    ],
  },
  {
    id: "M9-workflow-run-accepted",
    category: "workflow-run-accepted",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "exposes only list/watch/audit and rejects workflow run before state effects",
    },
    edits: [
      {
        file: argSpec,
        before: 'choices: ["list", "watch", "audit"]',
        after: 'choices: ["list", "watch", "audit", "run"]',
      },
      {
        file: cli,
        before: 'const actions = ["list", "watch", "audit"] as const;',
        after: 'const actions = ["list", "watch", "audit", "run"] as const;',
      },
      {
        file: cli,
        before: '  if (command === "workflow") {\n    const action = argv[1] as',
        after:
          '  if (command === "workflow") {\n    if (argv[1] === "run") return 0;\n    const action = argv[1] as',
      },
    ],
  },
  {
    id: "M10-throttle-drops-audit",
    category: "throttle-drops-audit",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "audits every pipeline width even when the live surface throttles intermediates",
    },
    edits: [
      {
        file: service,
        before: "    this.liveEvents.emit(live);\n    this.auditTrail?.record(",
        after: "    if (!this.liveEvents.emit(live)) return;\n    this.auditTrail?.record(",
      },
    ],
  },
  {
    id: "M11-stale-refusal-poisons-writer",
    category: "stale-refusal-poisons-writer",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "settles a stale-fence refusal without poisoning the shared writer",
    },
    edits: [
      {
        file: auditTrail,
        before:
          'return this.repository.append(runId, input, ownership) === null ? "refused" : "saved";',
        after:
          'return this.repository.append(runId, input, ownership) === null ? "failed" : "saved";',
      },
    ],
  },
  {
    id: "M12-public-audit-wiring",
    category: "public-audit-wiring",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "installs workflow_audit in the same session registry used by public chat",
    },
    edits: [
      {
        file: chat,
        before: "return CHAT_TOOL_REGISTRY_FACTORIES.public(database, environment);",
        after: "return CHAT_TOOL_REGISTRY_FACTORIES.failSafe(database, environment);",
      },
    ],
  },
  {
    id: "M13-unbounded-sqlite-identity",
    category: "unbounded-sqlite-identity",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "bounds every persisted identity column before the SQLite boundary",
    },
    edits: [
      {
        file: repository,
        before:
          "            auditRunId,\n            seq,\n            identity.segment_id ?? null,\n            nodePath[0] ?? null,\n            identity.sub_id ?? null,\n            identity.attempt ?? null,",
        after:
          "            runId,\n            seq,\n            input.segment_id ?? null,\n            input.node_id ?? null,\n            input.sub_id ?? null,\n            input.attempt ?? null,",
      },
    ],
  },
  {
    id: "M14-raw-marker-bypass",
    category: "raw-marker-bypass",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "rejects marker-shaped objects in raw fields except policy-produced markers",
    },
    edits: [
      {
        file: auditModel,
        before:
          '      if (\n        preserved?.state === "excluded_by_policy" ||\n        (PRIVATE_FIELDS.has(key) && preserved?.state === "excluded_private_state")\n      )\n        return preserved;',
        after: "      if (preserved !== null) return preserved;",
      },
    ],
  },
  {
    id: "M15-gap-before-accepted-event",
    category: "gap-before-accepted-event",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "persists an already accepted event before its overflow gap",
    },
    edits: [
      {
        file: auditTrail,
        before:
          "      if (marker !== undefined && (next === undefined || marker.order < next.order)) {",
        after: "      if (marker !== undefined) {",
      },
    ],
  },
  {
    id: "M16-binary-marker-idempotence",
    category: "binary-marker-idempotence",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "keeps binary raw-field markers stable across the SQLite read boundary",
    },
    edits: [
      {
        file: auditModel,
        before:
          'return Object.freeze({\n      state: "excluded_by_policy",\n      bytes: value.byteLength,\n    });',
        after:
          'return Object.freeze({\n      state: "excluded_by_policy",\n      bytes: Math.min(value.byteLength, 256),\n    });',
      },
    ],
  },
  {
    id: "M17-overflow-epochs",
    category: "overflow-epochs",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "separates overflow gaps when an accepted event starts a new loss epoch",
    },
    edits: [
      {
        file: auditTrail,
        before:
          "const acceptedSincePrior = (this.lastAcceptedOrder.get(runId) ?? 0) > (prior?.order ?? 0);",
        after: "const acceptedSincePrior = false;",
      },
    ],
  },
  {
    id: "M18-run-id-collision",
    category: "run-id-collision",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "keeps overlong run identifiers distinct after applying the public bound",
    },
    edits: [
      {
        file: auditModel,
        before:
          'function boundedRunId(value: string): string {\n  if (Array.from(value).length <= 128) return value;\n  const digest = createHash("sha256").update(value).digest("hex").slice(0, 32);\n  return `${clipped(value, 95)}~${digest}`;\n}',
        after: "function boundedRunId(value: string): string {\n  return clipped(value, 128);\n}",
      },
    ],
  },
  {
    id: "M19-reentrant-drain",
    category: "reentrant-drain",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "prevents a reentrant record from starting a concurrent drain",
    },
    edits: [
      {
        file: auditTrail,
        before: "const task = Promise.resolve().then(() => this.drain());",
        after: "const task = this.drain();",
      },
    ],
  },
  {
    id: "M20-binary-marker-policy-state",
    category: "binary-marker-policy-state",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "keeps binary raw-field markers stable across the SQLite read boundary",
    },
    edits: [
      {
        file: auditModel,
        before:
          'return Object.freeze({\n      state: "excluded_by_policy",\n      bytes: value.byteLength,\n    });',
        after:
          'return Object.freeze({\n      state: "unavailable",\n      bytes: value.byteLength,\n    });',
      },
    ],
  },
  {
    id: "M21-bounded-accepted-order",
    category: "bounded-accepted-order",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "releases accepted-order bookkeeping after runs become idle",
    },
    edits: [
      {
        file: auditTrail,
        before:
          "  private clearAcceptedOrderIfIdle(runId: string): void {\n    if (\n      !this.dropped.some((entry) => entry.runId === runId) &&\n      !this.queue.some((entry) => entry.runId === runId)\n    )\n      this.lastAcceptedOrder.delete(runId);\n  }",
        after: "  private clearAcceptedOrderIfIdle(runId: string): void {\n    void runId;\n  }",
      },
    ],
  },
  {
    id: "M22-run-chat-public-audit-wiring",
    category: "run-chat-public-audit-wiring",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "routes workflow_audit through the actual runChat composition root",
    },
    edits: [
      {
        file: chat,
        before: "toolDispatcher: new RegistryToolDispatcher(tools.dispatch),",
        after:
          "toolDispatcher: new RegistryToolDispatcher(((registry) => registry.dispatch.bind(registry))(CHAT_TOOL_REGISTRY_FACTORIES.failSafe(connection.database, options.environment))),",
      },
    ],
  },
  {
    id: "M23-binary-marker-read-size",
    category: "binary-marker-read-size",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "keeps binary raw-field markers stable across the SQLite read boundary",
    },
    edits: [
      {
        file: auditModel,
        before: 'for (const key of ["bytes", "original_bytes", "limit_bytes"])',
        after: 'for (const key of ["original_bytes", "limit_bytes"])',
      },
    ],
  },
  {
    id: "M24-binary-safe-value-size",
    category: "binary-safe-value-size",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "keeps binary raw-field markers stable across the SQLite read boundary",
    },
    edits: [
      {
        file: auditModel,
        before:
          'return Object.freeze({\n      state: "unavailable",\n      bytes: value.byteLength,\n    });',
        after:
          'return Object.freeze({\n      state: "unavailable",\n      bytes: Math.min(value.byteLength, 256),\n    });',
      },
    ],
  },
  {
    id: "M25-no-late-shutdown-attempts",
    category: "no-late-shutdown-attempts",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "never retries the sink after a timed-out shutdown returns",
    },
    edits: [
      {
        file: auditTrail,
        before:
          'await this.sleep(this.retryDelay);\n        if (this.isStopped()) return "failed";',
        after: "await this.sleep(this.retryDelay);",
      },
    ],
  },
  {
    id: "M26-bounded-drop-buckets",
    category: "bounded-drop-buckets",
    mechanism: "family-a",
    focus: { file: focusFile, test: "bounds loss buckets and conserves every overflowed event" },
    edits: [
      {
        file: auditTrail,
        before:
          "      (prior === undefined || acceptedSincePrior) &&\n      this.dropped.length >= this.maxDropBuckets - 1",
        after:
          "      (prior === undefined || acceptedSincePrior) &&\n      this.dropped.length >= this.maxDropBuckets - 1 &&\n      this.maxDropBuckets < 0",
      },
    ],
  },
  {
    id: "M27-corrupt-payload-cause",
    category: "corrupt-payload-cause",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "preserves corrupt_payload when sanitizer failure meets a full queue",
    },
    edits: [
      {
        file: auditTrail,
        before: 'this.markDropped(order, runId, "corrupt_payload", ownership);',
        after: 'this.markDropped(order, runId, "queue_overflow", ownership);',
      },
    ],
  },
  {
    id: "M28-private-marker-scope",
    category: "private-marker-scope",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "rejects marker-shaped objects in raw fields except policy-produced markers",
    },
    edits: [
      {
        file: auditModel,
        before: '(PRIVATE_FIELDS.has(key) && preserved?.state === "excluded_private_state")',
        after: 'preserved?.state === "excluded_private_state"',
      },
    ],
  },
  {
    id: "M29-drop-attribution-emission",
    category: "drop-attribution-emission",
    mechanism: "family-a",
    focus: { file: focusFile, test: "bounds loss buckets and conserves every overflowed event" },
    edits: [
      {
        file: auditTrail,
        before: '        ...(marker.runId === "$audit" ? { run_attribution: "unavailable" } : {}),',
        after: "",
      },
    ],
  },
  {
    id: "M30-drop-attribution-allowlist",
    category: "drop-attribution-allowlist",
    mechanism: "family-a",
    focus: { file: focusFile, test: "bounds loss buckets and conserves every overflowed event" },
    edits: [
      {
        file: auditModel,
        before: '  run_attribution: new Set(["unavailable"]),\n',
        after: "",
      },
    ],
  },
  {
    id: "M31-private-marker-family",
    category: "private-marker-family",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "rejects marker-shaped objects in raw fields except policy-produced markers",
    },
    edits: [
      {
        file: auditModel,
        before: "PRIVATE_FIELDS.has(key)",
        after: 'key === "reasoning"',
      },
    ],
  },
  {
    id: "M32-inflight-drop-double-count",
    category: "inflight-drop-double-count",
    mechanism: "family-a",
    focus: {
      file: focusFile,
      test: "never persists an in-flight drop count twice when producers reenter",
    },
    edits: [
      {
        file: auditTrail,
        before: "    this.dropped.splice(index, 1);\n    const gap: AuditInput = Object.freeze({",
        after: "    const gap: AuditInput = Object.freeze({",
      },
      {
        file: auditTrail,
        before:
          '    const outcome = await this.append(marker.runId, gap, marker.ownership);\n    if (outcome === "failed") {',
        after:
          '    const outcome = await this.append(marker.runId, gap, marker.ownership);\n    const persistedIndex = this.dropped.indexOf(marker);\n    if (persistedIndex >= 0) this.dropped.splice(persistedIndex, 1);\n    if (outcome === "failed") {',
      },
    ],
  },
];
