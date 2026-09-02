import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../../scripts/parity/canonical.js";
import { compareRuns } from "../../scripts/parity/compare.js";
import { parseScenarioManifest } from "../../scripts/parity/manifest.js";
import type { RunRecord } from "../../scripts/parity/types.js";

const scenarios = [
  "oracle-version",
  "oracle-no-subcommand",
  "oracle-workflow-list",
  "events-jsonl-fixture",
  "deliberate-divergence",
];

const sprint02Scenarios = [
  "ts-version",
  "ts-no-subcommand",
  "ts-help",
  "ts-doctor-down",
  "ts-doctor-text-down",
  "ts-doctor-env-file",
  "ts-doctor-env-sources",
  "ts-doctor-profile",
  "ts-doctor-invalid-profile",
  "ts-doctor-unicode-profile",
  "ts-doctor-invalid-order",
  "ts-doctor-home-override",
  "ts-doctor-env-profile",
  "normalization-replace-text",
  "normalization-replace-json-pointer",
  "serializer-json-stringify-divergence",
] as const;

const sprint03Scenarios = [
  "t02-doctor-down",
  "t02-doctor-up",
  "t02-doctor-empty-models",
  "t02-chat-auto-json",
  "t02-chat-auto-empty-models",
  "t02-chat-json-no-tools",
  "t02-chat-stream",
  "t02-chat-stream-nodone",
  "t02-chat-stream-options-retry",
  "t02-chat-tool-read-file-json",
  "t02-chat-tool-read-file-stream",
  "t02-chat-tool-unknown",
  "t02-chat-http-401",
  "t02-chat-http-500",
  "t02-chat-auto-down",
  "t02-chat-explicit-down",
  "t02-chat-provider-without-model-up",
  "t02-deliberate-divergence",
] as const;

describe("versioned scenarios", () => {
  it.each(scenarios)("parses %s without an author-local absolute path", (name) => {
    const path = resolve(`scripts/parity/scenarios/${name}.json`);
    const source = readFileSync(path, "utf8");
    expect(source).not.toContain("/Users/");
    expect(source).not.toContain(".oracle-venv/bin/lohra");
    expect(parseScenarioManifest(JSON.parse(source) as unknown).id).toBe(name);
  });

  it("declares the volatile SQLite shm exclusion only in workflow capture policy", () => {
    const source = JSON.parse(
      readFileSync(resolve("scripts/parity/scenarios/oracle-workflow-list.json"), "utf8"),
    ) as { capture: { tree: { exclude: string[] } } };
    expect(source.capture.tree.exclude).toEqual([".lohra/state.db-shm"]);
  });

  it.each(sprint02Scenarios)("parses Sprint 02 scenario %s portably", (name) => {
    const path = resolve(`scripts/parity/scenarios/${name}.json`);
    const source = readFileSync(path, "utf8");
    expect(source).not.toContain("/Users/");
    expect(parseScenarioManifest(JSON.parse(source) as unknown).id).toBe(name);
  });

  it.each(sprint02Scenarios)("fixes COLUMNS=80 in Sprint 02 scenario %s", (name) => {
    const source = JSON.parse(
      readFileSync(resolve(`scripts/parity/scenarios/${name}.json`), "utf8"),
    ) as { environment: { set: Record<string, string> } };
    expect(source.environment.set.COLUMNS).toBe("80");
  });

  it("declares the stub-down port precondition on every doctor scenario", () => {
    for (const name of sprint02Scenarios.filter((scenario) => scenario.includes("doctor"))) {
      const source = JSON.parse(
        readFileSync(resolve(`scripts/parity/scenarios/${name}.json`), "utf8"),
      ) as { preconditions: unknown[] };
      expect(source.preconditions).toEqual([
        { kind: "tcp-port-closed", host: "127.0.0.1", port: 11434 },
      ]);
    }
  });

  it("exercises both formerly unit-only normalizers in versioned scenarios", () => {
    const text = JSON.parse(
      readFileSync(resolve("scripts/parity/scenarios/normalization-replace-text.json"), "utf8"),
    ) as { normalizations: Array<{ kind: string }> };
    const pointer = JSON.parse(
      readFileSync(
        resolve("scripts/parity/scenarios/normalization-replace-json-pointer.json"),
        "utf8",
      ),
    ) as { normalizations: Array<{ kind: string }> };

    expect(text.normalizations.map(({ kind }) => kind)).toContain("replace-text");
    expect(pointer.normalizations.map(({ kind }) => kind)).toContain("replace-json-pointer");
  });

  it.each(sprint03Scenarios)("parses Sprint 03 scenario %s with explicit stub policy", (name) => {
    const path = resolve(`scripts/parity/scenarios/${name}.json`);
    const source = readFileSync(path, "utf8");
    const manifest = parseScenarioManifest(JSON.parse(source) as unknown);

    expect(source).not.toContain("/Users/");
    expect(manifest.id).toBe(name);
    expect(manifest.stub).toBeDefined();
    expect(manifest.preconditions).toEqual([
      { kind: "tcp-port-closed", host: "127.0.0.1", port: 11434 },
    ]);
    expect(
      manifest.capture.events.find(({ name: event }) => event === "requestsRaw"),
    ).toMatchObject({ projection: "raw-only" });
  });
});

describe("t15 chat evidence reproducibility", () => {
  const t15ManifestPath = "scripts/parity/manifests/t15/t15-chat-workflow.json";

  interface T15Policy {
    readonly comparisons: readonly { readonly class: string; readonly field: string }[];
    readonly normalizations: readonly {
      readonly field: string;
      readonly kind: string;
      readonly pattern?: string;
      readonly hashOnly?: boolean;
    }[];
  }

  const loadT15Policy = (): T15Policy =>
    JSON.parse(readFileSync(resolve(t15ManifestPath), "utf8")) as T15Policy;

  const requestRecord = (
    toolContent: string,
    model = "stub-coder:1b",
  ): RunRecord => ({
    process: {
      exitCode: 0,
      signal: null,
      stdout: Buffer.from("").toString("base64"),
      stderr: Buffer.from("").toString("base64"),
    },
    tree: [],
    sqlite: {},
    events: {
      requests: {
        exists: true,
        records: [
          {
            seq: 2,
            method: "POST",
            path: "/v1/chat/completions",
            headers: { host: "127.0.0.1:11434" },
            body: {
              model,
              messages: [
                { role: "user", content: "run the canned workflow" },
                { role: "tool", tool_call_id: "call_stub_s1", content: toolContent },
              ],
            },
          },
        ],
      },
      summary: { exists: true, records: { gets: 0, posts: 2 } },
      assertions: { exists: true, records: { valid: true, failures: [] } },
    },
  });

  const runtimeValues = {
    oracle: { home: "/one/home", profile: "/one/profile" },
    candidate: { home: "/two/home", profile: "/two/profile" },
  };

  it("compares events.requests with a non-hash-only run-id normalization", () => {
    const policy = loadT15Policy();

    expect(policy.comparisons).toContainEqual({ class: "stub", field: "events.requests" });
    const rule = policy.normalizations.find((entry) => entry.field === "events.requests");
    expect(rule).toMatchObject({ kind: "replace-regex" });
    expect(rule?.pattern).toContain('"run_id"');
    expect(rule?.hashOnly).toBeUndefined();
  });

  it("matches bilateral run-id divergence for hex and pinned probe ids", () => {
    const policy = loadT15Policy();
    const oracle = requestRecord(
      `{"ok": true, "run_id": "${"a".repeat(32)}", "status": "started"}`,
    );
    const candidate = requestRecord(
      `{"ok": true, "run_id": "run-1", "status": "started"}`,
    );

    const result = compareRuns(oracle, candidate, {
      comparisons: policy.comparisons as never,
      normalizations: policy.normalizations as never,
      runtimeValues,
    });

    expect(result.verdict).toBe("match");
    const normalized = result.normalized["events.requests"];
    expect(canonicalJson(normalized?.oracle)).toBe(canonicalJson(normalized?.candidate));
    const rendered = JSON.stringify(normalized?.oracle);
    expect(rendered).toContain("<run-id>");
    expect(rendered).not.toContain("a".repeat(32));
    expect(rendered).not.toContain("run-1");
  });

  it("does not mask an unrelated divergent field in events.requests", () => {
    const policy = loadT15Policy();
    const oracle = requestRecord(
      `{"ok": true, "run_id": "${"a".repeat(32)}", "status": "started"}`,
      "stub-coder:1b",
    );
    const candidate = requestRecord(
      `{"ok": true, "run_id": "${"a".repeat(32)}", "status": "started"}`,
      "stub-coder:9b",
    );

    const result = compareRuns(oracle, candidate, {
      comparisons: policy.comparisons as never,
      normalizations: policy.normalizations as never,
      runtimeValues,
    });

    expect(result.verdict).toBe("divergent");
  });

  it("never normalizes the status or other fields around the run_id value", () => {
    const policy = loadT15Policy();
    const oracle = requestRecord(
      `{"ok": true, "run_id": "${"a".repeat(32)}", "status": "started"}`,
    );
    const candidate = requestRecord(`{"ok": true, "run_id": "run-1", "status": "running"}`);

    const result = compareRuns(oracle, candidate, {
      comparisons: policy.comparisons as never,
      normalizations: policy.normalizations as never,
      runtimeValues,
    });

    expect(result.verdict).toBe("divergent");
  });

  it("fails closed when the run_id key or a non-empty value is missing", () => {
    const policy = loadT15Policy();
    const oracle = requestRecord(`{"ok": true, "run_id": "${"a".repeat(32)}", "status": "x"}`);
    const candidate = requestRecord(`{"ok": true, "status": "started"}`);

    expect(() =>
      compareRuns(oracle, candidate, {
        comparisons: policy.comparisons as never,
        normalizations: policy.normalizations as never,
        runtimeValues,
      }),
    ).toThrow(/NORMALIZATION_MISS|did not match its declared pattern/);
  });

  it("composes the candidate chat system prompt with the real product builder", () => {
    const source = readFileSync(
      resolve("scripts/parity/workflow-executor/candidate-chat.mjs"),
      "utf8",
    );

    expect(source).toContain('buildSystemPrompt({ systemMessage: "T15 canned workflow chat" })');
    expect(source).not.toContain('promptSnapshot: () => "T15 canned workflow chat"');
  });

  it("detects run-id divergence when the normalization rule is absent", () => {
    const oracleRunId = "a".repeat(32);
    const candidateRunId = "b".repeat(32);
    const oracle = requestRecord(
      `{"ok": true, "run_id": "${oracleRunId}", "status": "started"}`,
    );
    const candidate = requestRecord(
      `{"ok": true, "run_id": "${candidateRunId}", "status": "started"}`,
    );

    const result = compareRuns(oracle, candidate, {
      comparisons: [{ class: "stub", field: "events.requests" }],
      normalizations: [],
      runtimeValues,
    });

    expect(result.verdict).toBe("divergent");
  });
});

const expectedDivergentT20 = new Set([
  "t20-port-invalid",
  "t20-userinfo",
  "t20-non-public-literals",
  "t20-literal-public",
  "t20-redirect-flow",
  "t20-fetch-bounds",
  "t20-peer-matrix",
  "t20-ddg-byte-cap",
]);

const t20Scenarios = readdirSync(resolve("scripts/parity/manifests/t20"))
  .filter((name) => name.startsWith("t20-") && name.endsWith(".json"))
  .map((name) => name.slice(0, -5))
  .sort();

describe("sprint 05 T20 web tools matrix", () => {
  it("declares the closed 25-scenario inventory", () => {
    expect(t20Scenarios).toHaveLength(25);
    expect(t20Scenarios).toContain("t20-definitions");
    expect(t20Scenarios).toContain("t20-peer-divergent");
    expect(t20Scenarios).toContain("t20-rebinding");
    expect(t20Scenarios).toContain("t20-connector-tls");
    expect(t20Scenarios).toContain("t20-chat-canned");
    expect(t20Scenarios).toContain("t20-port-invalid");
    expect(t20Scenarios).toContain("t20-userinfo");
    expect(t20Scenarios).toContain("t20-peer-matrix");
    expect(t20Scenarios).toContain("t20-ddg-byte-cap");
  });

  it.each(t20Scenarios)("parses %s portably with the pinned oracle guard", (id) => {
    const path = resolve(`scripts/parity/manifests/t20/${id}.json`);
    const source = readFileSync(path, "utf8");
    expect(source).not.toContain("/Users/");
    const manifest = parseScenarioManifest(JSON.parse(source) as unknown);
    expect(manifest.id).toBe(id);
    expect(manifest.expectations.length).toBeGreaterThan(0);
    expect(manifest.oracleGuard).toMatchObject({
      expectedCommit: "16b4785d803ad0ca364a8a67346a04f949fbf592",
      expectedVersion: "lohra 0.0.11\n",
    });
  });

  it.each(t20Scenarios.filter((id) => expectedDivergentT20.has(id)))(
    "pins %s as an expected divergence on both sides",
    (id) => {
      const source = JSON.parse(
        readFileSync(resolve(`scripts/parity/manifests/t20/${id}.json`), "utf8"),
      ) as {
        expectations: Array<{ side: string; field: string }>;
        comparisons: Array<{ field: string }>;
      };
      const sides = source.expectations.map((expectation) => expectation.side);
      expect(sides).toContain("oracle");
      expect(sides).toContain("candidate");
      expect(source.comparisons.map(({ field }) => field)).toContain("process.stdout");
    },
  );

  it("poisons proxy environment on every T20 scenario", () => {
    for (const id of t20Scenarios) {
      const source = JSON.parse(
        readFileSync(resolve(`scripts/parity/manifests/t20/${id}.json`), "utf8"),
      ) as { environment: { set: Record<string, string> } };
      expect(source.environment.set.HTTP_PROXY).toContain("127.0.0.1:1");
      expect(source.environment.set.HTTPS_PROXY).toContain("127.0.0.1:1");
      expect(source.environment.set.ALL_PROXY).toContain("127.0.0.1:1");
    }
  });
});
