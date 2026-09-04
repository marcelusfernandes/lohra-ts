import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  architectureRulingMatches,
  componentTargetMatches,
  gatesEvidenceMatches,
} from "../scripts/parity/closeout/evidence-validation.js";
import { normalizeCloseoutOutput } from "../scripts/parity/closeout/normalization.js";

const root = resolve(import.meta.dirname, "..");
const source = (path: string): string => readFileSync(resolve(root, path), "utf8");

describe("T22 closeout invariants", () => {
  it("pins all approved ancestors and refuses platform spoofing", () => {
    const verifier = source("scripts/parity/closeout/verify-evidence.ts");
    for (const sha of [
      "5b2d62c65f282683609d5d3801b3bfaf4448aff4",
      "e4415ddabd6bf27196f443f7c95e282ebcef86af",
      "846daf9c3de7766b1736d02a1a4b3a52fa02d5f2",
      "879b16788d83ab32d45216c25403e9b4b8faecb1",
      "78b93ec89995ae72f275ec58c1acea5739b96da9",
      "9d98cc97473f5523d0a961ef48073456db40522d",
      "3c39315f48665eea5230b03c6c57ddd25fe377bb",
    ]) {
      expect(verifier, "MUTATION_CAUSE:T22-ancestor-inventory").toContain(sha);
    }
    expect(verifier, "MUTATION_CAUSE:T22-platform-spoof").toContain(
      'D16: { status: "NOT_MEASURED"',
    );
  });

  it("keeps updater subprocesses explicit, FF-only, and module-relative", () => {
    expect(source("src/self-update/repo.ts"), "MUTATION_CAUSE:T22-updater-shell").toContain(
      "shell: false",
    );
    expect(source("src/self-update/service.ts"), "MUTATION_CAUSE:T22-updater-ff-only").toContain(
      '["pull", "--ff-only"]',
    );
    expect(source("src/self-update/service.ts"), "MUTATION_CAUSE:T22-updater-cwd").toContain(
      "locateRepo(dirname(fileURLToPath(moduleUrl)))",
    );
  });

  it("uses node-pty and ephemeral closeout ports", () => {
    const terminal = source("src/tools/terminal.ts");
    expect(terminal, "MUTATION_CAUSE:T22-native-pty").toContain(
      'import { spawn as spawnPty } from "node-pty"',
    );
    expect(terminal).not.toContain('from "node:child_process"');
    const composition = source("scripts/parity/closeout/composition.ts");
    expect(composition, "MUTATION_CAUSE:T22-fixed-port").toContain(
      'upstream.listen(0, "127.0.0.1"',
    );
    expect(composition).not.toContain("11434");
  });

  it("keeps the native SQLite dependency compatible with the declared Node 20 floor", () => {
    const manifest = JSON.parse(source("package.json")) as {
      readonly dependencies?: Readonly<Record<string, string>>;
      readonly engines?: Readonly<Record<string, string>>;
    };
    expect(manifest.engines?.node).toBe(">=20");
    expect(
      manifest.dependencies?.["better-sqlite3"],
      "MUTATION_CAUSE:T22-node20-sqlite-dependency",
    ).toBe("11.10.0");
    expect(source("scripts/pack-check.ts")).toContain("prepareOfflineTarballConsumer");
    expect(source("scripts/parity/closeout/no-python.ts")).toContain(
      "prepareOfflineTarballConsumer",
    );
    expect(source("scripts/parity/provider-transports/pack-smoke.mjs")).toContain(
      "offline-tarball-install-cli.ts",
    );
  });

  it("keeps successful T19 test diagnostics inside the normalized Vitest stream", () => {
    expect(
      source("scripts/parity/mcp/run-regression-gates-locked.sh"),
      "MUTATION_CAUSE:T22-t19-test-stream-order",
    ).toContain("npm test 2>&1");
  });

  it("normalizes reporter telemetry without masking semantic fields", () => {
    const input =
      "user: Today's date is 2026-09-02; url=http://127.0.0.1:43210; path=/tmp/semantic\n RUN  v3.2.4 /tmp/worktree\n ✓ tests/example.test.ts (2 tests) 335ms\nloop start\n Test Files  1 passed (1)\n Tests  2 passed (2)\n Start at 02:33:59\n Duration 12.5s";
    const output = normalizeCloseoutOutput(input);
    expect(output, "MUTATION_CAUSE:T22-normalization-scope").toContain(
      "Today's date is 2026-09-02",
    );
    expect(output).toContain("127.0.0.1:43210");
    expect(output).toContain("/tmp/semantic");
    expect(output).toContain("<vitest-success-telemetry>");
    expect(output).not.toContain("tests/example.test.ts");
    expect(output).not.toContain("loop start");
    expect(output).toContain("Test Files  1 passed (1)");
    expect(output).toContain("Tests  2 passed (2)");
    expect(output).toContain("Start at <clock>");
    expect(output).toContain("Duration <duration>");
  });

  it("makes parallel successful Vitest scheduling and slow-test detail non-semantic", () => {
    const prefix = '{"suite":"semantic","failures":0}\n RUN  v3.2.4 /tmp/worktree\n';
    const suffix =
      "\n Test Files  2 passed (2)\n Tests  3 passed (3)\n Start at 02:33:59\n Duration 12.5s";
    const first = normalizeCloseoutOutput(
      `${prefix} ✓ tests/a.test.ts (2 tests) 335ms\n ✓ tests/b.test.ts (1 test) 2s${suffix}`,
    );
    const second = normalizeCloseoutOutput(
      `${prefix} ✓ tests/b.test.ts (1 test) 1s\n     ✓ slow detail 900ms\n ✓ tests/a.test.ts (2 tests) 20ms${suffix}`,
    );
    expect(first, "MUTATION_CAUSE:T22-vitest-parallel-telemetry").toBe(second);
  });

  it("normalizes only volatile T13 artifact hashes in the structured suite summary", () => {
    const summary = JSON.stringify({
      suite: "t13-orchestration-delegation",
      digest: "semantic-digest",
      projections: [
        {
          id: "scenario",
          sha: "judged-projection-sha",
          evidenceSha: "volatile-evidence-sha",
          class: "match",
        },
      ],
    });
    const semantic = JSON.stringify({
      suite: "user-payload",
      evidenceSha: "must-survive",
    });
    const output = normalizeCloseoutOutput(`${summary}\n${semantic}`);
    expect(output).toContain('"digest":"semantic-digest"');
    expect(output).toContain('"sha":"judged-projection-sha"');
    expect(output).toContain('"evidenceSha":"<volatile-artifact-sha>"');
    expect(output).toContain('"evidenceSha":"must-survive"');
  });

  it("normalizes only T16 lock-wait telemetry while preserving semantic fields", () => {
    const first = normalizeCloseoutOutput(
      JSON.stringify({
        suite: "t16-workflow-durability",
        targetSha: "semantic-sha",
        bilateralMatch: true,
        waitedForLockMs: 0,
      }),
    );
    const second = normalizeCloseoutOutput(
      JSON.stringify({
        suite: "t16-workflow-durability",
        targetSha: "semantic-sha",
        bilateralMatch: true,
        waitedForLockMs: 4_201,
      }),
    );
    const unrelated = normalizeCloseoutOutput(
      JSON.stringify({ suite: "user-payload", waitedForLockMs: 4_201 }),
    );
    expect(first, "MUTATION_CAUSE:T22-t16-lock-wait-telemetry").toBe(second);
    expect(first).toContain('"targetSha":"semantic-sha"');
    expect(first).toContain('"bilateralMatch":true');
    expect(first).toContain('"waitedForLockMs":"<lock-wait>"');
    expect(unrelated).toContain('"waitedForLockMs":4201');
  });

  it("requires exact-SHA aggregate evidence before marking the closeout complete", () => {
    const verifier = source("scripts/parity/closeout/verify-evidence.ts");
    expect(verifier, "MUTATION_CAUSE:T22-aggregate-evidence").toContain(
      "const aggregatesPass = parityAggregatePass && mutationAggregatePass;",
    );
    expect(verifier).toContain("closeout?.targetSha === targetSha");
    expect(verifier).toContain("mutations?.targetSha === targetSha");
  });

  it("binds every component and owner ruling before evidence integrity passes", () => {
    const verifier = source("scripts/parity/closeout/verify-evidence.ts");
    expect(
      componentTargetMatches({ targetSha: "stale" }, "current"),
      "MUTATION_CAUSE:T22-component-sha-binding",
    ).toBe(false);
    expect(componentTargetMatches({ targetSha: "current" }, "current")).toBe(true);
    expect(
      architectureRulingMatches(
        "decision absent",
        "typescript-mainline docs/gate-decision-t22.md marcelusfernandes 2026-09-03",
      ),
      "MUTATION_CAUSE:T22-owner-ruling-binding",
    ).toBe(false);
    expect(
      architectureRulingMatches(
        "typescript-mainline",
        "typescript-mainline docs/gate-decision-t22.md marcelusfernandes 2026-09-03",
      ),
    ).toBe(true);
    expect(verifier).toContain(
      "const architectureRulingPass = architectureRulingMatches(gateDecision, ruling)",
    );
    expect(verifier).toContain("const evidenceIndexPass =");
    expect(verifier).not.toContain('E22: { status: "PASS"');
    expect(verifier).toContain("process.env.LOHRA_T22_ARTIFACT_ROOT");
  });

  it("accepts measured growth in the full suite without stale exact-count constants", () => {
    const valid = {
      targetSha: "current",
      typecheck: true,
      lint: true,
      build: true,
      testFiles: 150,
      tests: 1475,
      format: true,
      pack: true,
    };
    expect(gatesEvidenceMatches(valid, "current"), "MUTATION_CAUSE:T22-measured-test-floor").toBe(
      true,
    );
    expect(
      gatesEvidenceMatches({ ...valid, tests: 1474 }, "current"),
      "MUTATION_CAUSE:T22-measured-test-floor",
    ).toBe(false);
  });
});
