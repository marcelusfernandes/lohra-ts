import { describe, expect, it } from "vitest";

import { compareRuns } from "../../scripts/parity/compare.js";
import type { RunRecord } from "../../scripts/parity/types.js";

function record(
  stdout: string,
  stderr = "",
  tree: RunRecord["tree"] = [],
  events: RunRecord["events"] = {},
): RunRecord {
  return {
    process: {
      exitCode: 0,
      signal: null,
      stdout: Buffer.from(stdout).toString("base64"),
      stderr: Buffer.from(stderr).toString("base64"),
    },
    tree,
    sqlite: {},
    events,
  };
}

describe("comparison", () => {
  it("detects a deliberate divergence and reports both values", () => {
    const result = compareRuns(record("lohra 0.0.11\n"), record("lohra 9.9.9\n"), {
      comparisons: [{ class: "byte", field: "process.stdout" }],
      normalizations: [],
      runtimeValues: {
        oracle: { home: "/one/home", profile: "/one/profile" },
        candidate: { home: "/two/home", profile: "/two/profile" },
      },
    });

    expect(result.verdict).toBe("divergent");
    expect(result.differences).toHaveLength(1);
  });

  it("normalizes only the explicitly declared field", () => {
    const result = compareRuns(
      record("/one/home\n", "/one/profile\n"),
      record("/two/home\n", "/two/profile\n"),
      {
        comparisons: [
          { class: "byte", field: "process.stdout" },
          { class: "byte", field: "process.stderr" },
        ],
        normalizations: [
          {
            field: "process.stdout",
            kind: "replace-runtime-path",
            source: "home",
            replacement: "<HOME>",
          },
        ],
        runtimeValues: {
          oracle: { home: "/one/home", profile: "/one/profile" },
          candidate: { home: "/two/home", profile: "/two/profile" },
        },
      },
    );

    expect(result.verdict).toBe("divergent");
    expect(result.differences.map((difference) => difference.field)).toEqual(["process.stderr"]);
  });

  it("does not implicitly hide a different state.db-shm capture", () => {
    const left = record("", "", [
      { path: ".lohra/state.db-shm", type: "file", size: 3, sha256: "aaa" },
    ]);
    const right = record("", "", [
      { path: ".lohra/state.db-shm", type: "file", size: 3, sha256: "bbb" },
    ]);
    const result = compareRuns(left, right, {
      comparisons: [{ class: "schema", field: "tree" }],
      normalizations: [],
      runtimeValues: {
        oracle: { home: "/one/home", profile: "/one/profile" },
        candidate: { home: "/two/home", profile: "/two/profile" },
      },
    });
    expect(result.verdict).toBe("divergent");
    expect(result.differences[0]?.field).toBe("tree");
  });

  it("patches one JSON pointer in a stream without reserializing any other byte", () => {
    const left = '{"session_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "escaped": "caf\\u00e9"}\n';
    const right = '{"session_id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "escaped": "caf\\u00e9"}\n';
    const result = compareRuns(record(left), record(right), {
      comparisons: [{ class: "byte", field: "process.stdout" }],
      normalizations: [
        {
          field: "process.stdout",
          kind: "replace-json-pointer",
          pointer: "/session_id",
          replacement: "<SESSION_ID>",
        },
      ],
      runtimeValues: {
        oracle: { home: "/one/home", profile: "/one/profile" },
        candidate: { home: "/two/home", profile: "/two/profile" },
      },
    });

    expect(result.verdict).toBe("match");
    expect(
      Buffer.from(result.normalized["process.stdout"]?.oracle as string, "base64").toString(),
    ).toBe('{"session_id": "<SESSION_ID>", "escaped": "caf\\u00e9"}\n');
  });

  it("normalizes runtime paths recursively in captured request events", () => {
    const left = record("", "", [], {
      requests: { exists: true, records: [{ body: { messages: [{ content: "/one/home/x" }] } }] },
    });
    const right = record("", "", [], {
      requests: { exists: true, records: [{ body: { messages: [{ content: "/two/home/x" }] } }] },
    });
    const result = compareRuns(left, right, {
      comparisons: [{ class: "stub", field: "events.requests" }],
      normalizations: [
        {
          field: "events.requests",
          kind: "replace-runtime-path",
          source: "home",
          replacement: "<HOME>",
        },
      ],
      runtimeValues: {
        oracle: { home: "/one/home", profile: "/one/profile" },
        candidate: { home: "/two/home", profile: "/two/profile" },
      },
    });
    expect(result.verdict).toBe("match");
  });

  it("applies only anchored regular-expression replacements", () => {
    const result = compareRuns(
      record(
        "",
        "session: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  (resume with --session aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)\nraw bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n",
      ),
      record(
        "",
        "session: cccccccccccccccccccccccccccccccc  (resume with --session cccccccccccccccccccccccccccccccc)\nraw dddddddddddddddddddddddddddddddd\n",
      ),
      {
        comparisons: [{ class: "byte", field: "process.stderr" }],
        normalizations: [
          {
            field: "process.stderr",
            kind: "replace-regex",
            pattern: "(?<=session: )[0-9a-f]{32}(?=  \\(resume with --session )",
            replacement: "<SESSION_ID>",
          },
          {
            field: "process.stderr",
            kind: "replace-regex",
            pattern: "(?<=--session )[0-9a-f]{32}(?=\\))",
            replacement: "<SESSION_ID>",
          },
        ],
        runtimeValues: {
          oracle: { home: "/one/home", profile: "/one/profile" },
          candidate: { home: "/two/home", profile: "/two/profile" },
        },
      },
    );
    expect(result.verdict).toBe("divergent");
    expect(
      Buffer.from(result.normalized["process.stderr"]?.oracle as string, "base64").toString(),
    ).toContain("raw bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });
});
