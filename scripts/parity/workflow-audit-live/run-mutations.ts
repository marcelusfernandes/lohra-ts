#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { canonicalJson } from "../canonical.js";
import { acquireLock, guardCandidate, releaseLock } from "./support.js";

const root = resolve(import.meta.dirname, "../../..");
const evidenceDir = resolve(root, ".parity-evidence/t17");
const ORACLE_SHA = "16b4785d803ad0ca364a8a67346a04f949fbf592";

interface Edit {
  readonly file: string;
  readonly before: string;
  readonly after: string;
}
interface Mutant {
  readonly id: string;
  readonly assertion: string;
  readonly test: string;
  readonly cause: string;
  readonly externalCause?: string;
  readonly edits: readonly Edit[];
}
const auditModel = "src/workflow/audit-model.ts";
const auditTrail = "src/workflow/audit-trail.ts";
const repository = "src/state/audit-repository.ts";
const live = "src/workflow/live-events.ts";
const argSpec = "src/cli/arg-spec.ts";
const cli = "src/cli.ts";
const service = "src/workflow/service.ts";
const chat = "src/commands/chat.ts";

const mutants: readonly Mutant[] = [
  {
    id: "M1-canary-leak",
    assertion: "A1",
    test: "redacts every private raw field",
    cause: "MUTATION_CAUSE:M1-canary-leak",
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
    assertion: "A2",
    test: "caps public events by serialized UTF-8 bytes",
    cause: "MUTATION_CAUSE:M2-character-cap",
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
    assertion: "A5/C4",
    test: "turns queue overflow into an explicit gap",
    cause: "MUTATION_CAUSE:M3-silent-overflow",
    edits: [
      {
        file: auditTrail,
        before:
          "      this.markDropped(order, runId, ownership);\n      this.warning(`audit queue overflow for run ${runId}`);",
        after: "      this.warning(`audit queue overflow for run ${runId}`);",
      },
    ],
  },
  {
    id: "M4-moving-snapshot",
    assertion: "B2",
    test: "freezes snapshots",
    cause: "MUTATION_CAUSE:M4-moving-snapshot",
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
    assertion: "B1",
    test: "rolls back sequence allocation",
    cause: "MUTATION_CAUSE:M5-nontransactional-seq",
    externalCause: "rollback sequence probe failed",
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
    assertion: "B8",
    test: "rejects a stale fence",
    cause: "MUTATION_CAUSE:M6-fence-ignored",
    externalCause: "stale fence probe failed",
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
    assertion: "C2",
    test: "throttles per run/node",
    cause: "MUTATION_CAUSE:M7-global-throttle",
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
    assertion: "C3",
    test: "never suppresses the last item width",
    cause: "MUTATION_CAUSE:M8-last-suppressed",
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
    assertion: "D5",
    test: "exposes only list/watch/audit",
    cause: "MUTATION_CAUSE:M9-workflow-run-accepted",
    externalCause: "CLI probe failed",
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
    assertion: "A5/C4",
    test: "audits every pipeline width",
    cause: "MUTATION_CAUSE:M10-throttle-drops-audit",
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
    assertion: "A5/B8",
    test: "settles a stale-fence refusal",
    cause: "MUTATION_CAUSE:M11-stale-refusal-poisons-writer",
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
    assertion: "D6",
    test: "installs workflow_audit in the same session registry used by public chat",
    cause: "MUTATION_CAUSE:M12-public-audit-wiring",
    externalCause: "public audit registry probe failed",
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
    assertion: "A3",
    test: "bounds every persisted identity column before the SQLite boundary",
    cause: "MUTATION_CAUSE:M13-unbounded-sqlite-identity",
    externalCause: "bounded identity probe failed",
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
    assertion: "A1/A3",
    test: "rejects marker-shaped objects in raw fields except policy-produced markers",
    cause: "MUTATION_CAUSE:M14-raw-marker-bypass",
    externalCause: "raw marker probe failed",
    edits: [
      {
        file: auditModel,
        before:
          '      if (\n        preserved?.state === "excluded_by_policy" ||\n        preserved?.state === "excluded_private_state"\n      )\n        return preserved;',
        after: "      if (preserved !== null) return preserved;",
      },
    ],
  },
  {
    id: "M15-gap-before-accepted-event",
    assertion: "C4",
    test: "persists an already accepted event before its overflow gap",
    cause: "MUTATION_CAUSE:M15-gap-before-accepted-event",
    externalCause: "causal overflow probe failed",
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
    assertion: "A1/A3",
    test: "keeps binary raw-field markers stable across the SQLite read boundary",
    cause: "MUTATION_CAUSE:M16-binary-marker-idempotence",
    externalCause: "raw marker idempotence probe failed",
    edits: [
      {
        file: auditModel,
        before:
          'return Object.freeze({\n      state: "excluded_by_policy",\n      bytes: Math.min(value.byteLength, 256),\n    });',
        after:
          'return Object.freeze({\n      state: "excluded_by_policy",\n      bytes: value.byteLength,\n    });',
      },
    ],
  },
  {
    id: "M17-overflow-epochs",
    assertion: "C4",
    test: "separates overflow gaps when an accepted event starts a new loss epoch",
    cause: "MUTATION_CAUSE:M17-overflow-epochs",
    externalCause: "overflow epochs probe failed",
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
    assertion: "A3/B1",
    test: "keeps overlong run identifiers distinct after applying the public bound",
    cause: "MUTATION_CAUSE:M18-run-id-collision",
    externalCause: "bounded run identity collision probe failed",
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
    assertion: "B1/C4",
    test: "prevents a reentrant record from starting a concurrent drain",
    cause: "MUTATION_CAUSE:M19-reentrant-drain",
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
    assertion: "A1/A3",
    test: "keeps binary raw-field markers stable across the SQLite read boundary",
    cause: "MUTATION_CAUSE:M16-binary-marker-idempotence",
    externalCause: "raw marker idempotence probe failed",
    edits: [
      {
        file: auditModel,
        before:
          'return Object.freeze({\n      state: "excluded_by_policy",\n      bytes: Math.min(value.byteLength, 256),\n    });',
        after:
          'return Object.freeze({\n      state: "unavailable",\n      bytes: Math.min(value.byteLength, 256),\n    });',
      },
    ],
  },
  {
    id: "M21-bounded-accepted-order",
    assertion: "A3/C4",
    test: "releases accepted-order bookkeeping after runs become idle",
    cause: "MUTATION_CAUSE:M21-bounded-accepted-order",
    edits: [
      {
        file: auditTrail,
        before:
          "  private clearAcceptedOrderIfIdle(runId: string): void {\n    if (\n      !this.dropped.some((entry) => entry.runId === runId) &&\n      !this.queue.some((entry) => entry.runId === runId)\n    )\n      this.lastAcceptedOrder.delete(runId);\n  }",
        after: "  private clearAcceptedOrderIfIdle(runId: string): void {\n    void runId;\n  }",
      },
    ],
  },
];

function run(
  cwd: string,
  executable: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
) {
  return spawnSync(executable, [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...environment },
  });
}

function replaceExact(path: string, edit: Edit): void {
  const before = readFileSync(path, "utf8");
  const count = before.split(edit.before).length - 1;
  if (count !== 1)
    throw new Error(`${edit.file}: anchor count ${String(count)} for ${edit.before}`);
  writeFileSync(path, before.replace(edit.before, edit.after));
}

const candidate = guardCandidate(root);
mkdirSync(evidenceDir, { recursive: true });
acquireLock();
const archive = mkdtempSync(resolve(tmpdir(), "lohra-t17-mutations-"));
try {
  const baseline = run(root, resolve(root, "node_modules/.bin/vitest"), [
    "run",
    "tests/workflow-audit-live.test.ts",
  ]);
  if (baseline.status !== 0)
    throw new Error(`mutation baseline red: ${baseline.stdout}\n${baseline.stderr}`);
  const observations = [];
  for (const mutant of mutants) {
    const copy = resolve(archive, mutant.id.replaceAll("/", "-"));
    mkdirSync(copy);
    const exported = spawnSync("/usr/bin/git", ["archive", candidate.sha], {
      cwd: root,
      encoding: null,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (exported.status !== 0) throw new Error(`git archive failed for ${mutant.id}`);
    const extracted = spawnSync("/usr/bin/tar", ["-x", "-C", copy], { input: exported.stdout });
    if (extracted.status !== 0) throw new Error(`tar failed for ${mutant.id}`);
    symlinkSync(resolve(root, "node_modules"), resolve(copy, "node_modules"), "dir");
    for (const edit of mutant.edits) replaceExact(resolve(copy, edit.file), edit);
    const compile = run(copy, resolve(root, "node_modules/.bin/tsc"), [
      "-p",
      "tsconfig.build.json",
    ]);
    const test =
      compile.status === 0
        ? run(copy, resolve(root, "node_modules/.bin/vitest"), [
            "run",
            "tests/workflow-audit-live.test.ts",
            "-t",
            mutant.test,
          ])
        : compile;
    const output = `${test.stdout}\n${test.stderr}`;
    const causeVisible = output.includes(mutant.cause);
    const external =
      compile.status === 0 && mutant.externalCause !== undefined
        ? run(
            copy,
            resolve(root, "node_modules/.bin/tsx"),
            ["scripts/parity/workflow-audit-live/probe.ts"],
            {
              LOHRA_T17_MUTATION_ARCHIVE_SHA: candidate.sha,
              LOHRA_T17_MUTATION_ID: mutant.id,
            },
          )
        : null;
    const externalOutput = external === null ? "" : `${external.stdout}\n${external.stderr}`;
    const externalPassed =
      mutant.externalCause === undefined ||
      (external?.status !== 0 && externalOutput.includes(mutant.externalCause));
    const killed = compile.status === 0 && test.status !== 0 && causeVisible && externalPassed;
    observations.push({
      id: mutant.id,
      assertion: mutant.assertion,
      anchors: mutant.edits.length,
      compiled: compile.status === 0,
      exit: test.status,
      killed,
      causeVisible,
      external: Object.freeze({
        required: mutant.externalCause !== undefined,
        command:
          mutant.externalCause === undefined
            ? null
            : "tsx scripts/parity/workflow-audit-live/probe.ts",
        exit: external?.status ?? null,
        cause: mutant.externalCause ?? null,
        causeVisible:
          mutant.externalCause === undefined || externalOutput.includes(mutant.externalCause),
      }),
      observation: canonicalJson({
        compileExit: compile.status,
        testExit: test.status,
        causeVisible,
        externalExit: external?.status ?? null,
        externalCauseVisible:
          mutant.externalCause === undefined || externalOutput.includes(mutant.externalCause),
      }),
    });
  }
  const survivors = observations.filter((item) => !item.killed);
  const restore = run(root, resolve(root, "node_modules/.bin/vitest"), [
    "run",
    "tests/workflow-audit-live.test.ts",
  ]);
  const record = {
    targetSha: candidate.sha,
    oracleSha: ORACLE_SHA,
    baselineGreen: true,
    observations,
    survivors: survivors.map((item) => item.id),
    restoreGreen: restore.status === 0,
  };
  const digest = createHash("sha256").update(canonicalJson(record)).digest("hex");
  writeFileSync(
    resolve(evidenceDir, "mutations.json"),
    `${JSON.stringify({ ...record, digest }, null, 2)}\n`,
  );
  if (survivors.length > 0 || restore.status !== 0)
    throw new Error(`mutation failures: ${survivors.map((item) => item.id).join(",")}`);
  console.log(
    JSON.stringify({
      targetSha: candidate.sha,
      killed: observations.length,
      survivors: [],
      digest,
    }),
  );
} finally {
  rmSync(archive, { recursive: true, force: true });
  releaseLock();
}
