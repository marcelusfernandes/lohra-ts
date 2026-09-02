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
  readonly edits: readonly Edit[];
}
const auditModel = "src/workflow/audit-model.ts";
const auditTrail = "src/workflow/audit-trail.ts";
const repository = "src/state/audit-repository.ts";
const live = "src/workflow/live-events.ts";
const argSpec = "src/cli/arg-spec.ts";
const cli = "src/cli.ts";
const service = "src/workflow/service.ts";

const mutants: readonly Mutant[] = [
  {
    id: "M1-canary-leak",
    assertion: "A1",
    test: "redacts every private raw field",
    cause: "MUTATION_CAUSE:M1-canary-leak",
    edits: [
      {
        file: auditModel,
        before: 'const RAW_FIELDS = new Set(["prompt", "response"',
        after: 'const RAW_FIELDS = new Set(["response"',
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
          "      this.markDropped(runId, ownership);\n      this.warning(`audit queue overflow for run ${runId}`);",
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
];

function run(cwd: string, executable: string, args: readonly string[]) {
  return spawnSync(executable, [...args], { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
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
    const killed = compile.status === 0 && test.status !== 0 && causeVisible;
    observations.push({
      id: mutant.id,
      assertion: mutant.assertion,
      anchors: mutant.edits.length,
      compiled: compile.status === 0,
      exit: test.status,
      killed,
      causeVisible,
      observation: output.slice(-1_000),
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
