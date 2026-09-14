// Issue #576: unit tests do harness — parsing de caso, os dois oráculos, e
// a escrita incremental de `results.jsonl` (um crash no meio do lote não
// perde as linhas já gravadas). Nunca spawna o CLI real; isso é coberto por
// `tests/eval-cases.test.ts` contra o stub.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseEvalCase } from "../scripts/eval/case.js";
import { refuseNetworkInCi } from "../scripts/eval/ci-guard.js";
import { evaluateMechanism, evaluateOutcome } from "../scripts/eval/oracles.js";
import { appendResultLine, buildSummary, resetResultsFile } from "../scripts/eval/results.js";
import { parseArgs, runBatch } from "../scripts/eval/run.js";
import { runCaseSafely, runCaseToResultLine } from "../scripts/eval/runner.js";
import type { CapturedRequest, EvalCase, EvalResultLine } from "../scripts/eval/types.js";
import type { EvalSessionResult } from "../scripts/eval/session.js";

const roots: string[] = [];

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "lohra-eval-runner-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const MINIMAL_CASE = {
  input: "hello",
  stub_script: { default: [{ kind: "text", content: "STUB-OK" }] },
  mechanism: [{ kind: "request_count", count: 1 }],
  outcome: { question: "did it reply?", expect: "STUB-OK" },
  budget_tokens: 100,
};

describe("parseEvalCase", () => {
  it("parses a minimal, valid case", () => {
    const kase = parseEvalCase(MINIMAL_CASE, "fixture.json", "minimal-case");
    expect(kase.id).toBe("minimal-case");
    expect(kase.input).toBe("hello");
    expect(kase.stubScript.default?.[0]).toEqual({ kind: "text", content: "STUB-OK" });
    expect(kase.mechanism).toEqual([{ kind: "request_count", count: 1 }]);
    expect(kase.outcome).toEqual({ question: "did it reply?", expect: "STUB-OK" });
    expect(kase.budgetTokens).toBe(100);
    expect(kase.cwdFixture).toBeUndefined();
  });

  it("parses an optional cwd_fixture", () => {
    const kase = parseEvalCase(
      { ...MINIMAL_CASE, cwd_fixture: { path: "tool-target.txt", content: "x" } },
      "fixture.json",
      "with-fixture",
    );
    expect(kase.cwdFixture).toEqual({ path: "tool-target.txt", content: "x" });
  });

  it("carries an optional note through untouched", () => {
    const kase = parseEvalCase(
      { ...MINIMAL_CASE, note: "muda quando #577 mergear" },
      "fixture.json",
      "with-note",
    );
    expect(kase.note).toBe("muda quando #577 mergear");
  });

  it("rejects a case that is not a JSON object", () => {
    expect(() => parseEvalCase("nope", "fixture.json", "bad")).toThrow(/não é um objeto JSON/);
  });

  it("rejects a case missing input", () => {
    const rest: Record<string, unknown> = { ...MINIMAL_CASE };
    delete rest.input;
    expect(() => parseEvalCase(rest, "fixture.json", "bad")).toThrow(/"input"/);
  });

  it("rejects a case with a non-array mechanism", () => {
    expect(() =>
      parseEvalCase({ ...MINIMAL_CASE, mechanism: "nope" }, "fixture.json", "bad"),
    ).toThrow(/"mechanism" precisa ser array/);
  });

  // Issue #607 item 4: `mechanism: []` passaria vacuamente por
  // `evaluateMechanism` (todo `.every()` sobre array vazio é `true`) —
  // um caso sem nenhuma assertion de mecanismo estaria sempre "verde" sem
  // provar nada. `parseEvalCase` recusa isso na borda, antes do runner.
  it("rejects a case with an empty mechanism array (would pass vacuously)", () => {
    expect(() => parseEvalCase({ ...MINIMAL_CASE, mechanism: [] }, "fixture.json", "bad")).toThrow(
      /"mechanism" precisa ter pelo menos uma assertion/,
    );
  });

  it("rejects a mechanism assertion with an unknown kind", () => {
    expect(() =>
      parseEvalCase(
        { ...MINIMAL_CASE, mechanism: [{ kind: "not_a_real_kind" }] },
        "fixture.json",
        "bad",
      ),
    ).toThrow(/kind desconhecido/);
  });

  it("rejects a non-positive budget_tokens", () => {
    expect(() =>
      parseEvalCase({ ...MINIMAL_CASE, budget_tokens: 0 }, "fixture.json", "bad"),
    ).toThrow(/budget_tokens/);
  });

  it("rejects a stub_script step with an unknown kind", () => {
    expect(() =>
      parseEvalCase(
        { ...MINIMAL_CASE, stub_script: { default: [{ kind: "not_a_step" }] } },
        "fixture.json",
        "bad",
      ),
    ).toThrow(/kind desconhecido/);
  });
});

function request(messages: readonly Record<string, unknown>[]): CapturedRequest {
  return { seq: 1, method: "POST", path: "/v1/chat/completions", body: { messages } };
}

describe("evaluateMechanism", () => {
  it("system_prompt_includes passes when the first request's system message contains the substring", () => {
    const requests = [request([{ role: "system", content: "You are Lohra." }])];
    const [result] = evaluateMechanism(
      [{ kind: "system_prompt_includes", substring: "You are Lohra" }],
      requests,
      null,
    );
    expect(result?.passed).toBe(true);
  });

  it("system_prompt_includes fails when the substring is absent", () => {
    const requests = [request([{ role: "system", content: "You are Lohra." }])];
    const [result] = evaluateMechanism(
      [{ kind: "system_prompt_includes", substring: "not present" }],
      requests,
      null,
    );
    expect(result?.passed).toBe(false);
  });

  it("system_prompt_excludes passes when the substring is absent", () => {
    const requests = [request([{ role: "system", content: "You are Lohra." }])];
    const [result] = evaluateMechanism(
      [{ kind: "system_prompt_excludes", substring: "not present" }],
      requests,
      null,
    );
    expect(result?.passed).toBe(true);
  });

  it("request_count matches the number of captured requests", () => {
    const requests = [request([]), request([])];
    const [result] = evaluateMechanism([{ kind: "request_count", count: 2 }], requests, null);
    expect(result?.passed).toBe(true);
  });

  it("request_count fails on a mismatch, e.g. an unwanted retry", () => {
    const requests = [request([]), request([])];
    const [result] = evaluateMechanism([{ kind: "request_count", count: 1 }], requests, null);
    expect(result?.passed).toBe(false);
    expect(result?.detail).toContain("esperado 1");
  });

  it("message_roles_at_request compares the exact role sequence of the Nth request", () => {
    const requests = [
      request([{ role: "system" }, { role: "user" }, { role: "assistant" }, { role: "tool" }]),
    ];
    const [result] = evaluateMechanism(
      [
        {
          kind: "message_roles_at_request",
          request: 1,
          roles: ["system", "user", "assistant", "tool"],
        },
      ],
      requests,
      null,
    );
    expect(result?.passed).toBe(true);
  });

  it("tool_result_includes reads the last tool-role message of the Nth request", () => {
    const requests = [
      request([{ role: "user", content: "x" }]),
      request([
        { role: "user", content: "x" },
        { role: "assistant", content: null },
        { role: "tool", content: "command was not approved by the user" },
      ]),
    ];
    const [result] = evaluateMechanism(
      [{ kind: "tool_result_includes", request: 2, substring: "not approved by the user" }],
      requests,
      null,
    );
    expect(result?.passed).toBe(true);
  });

  it("envelope_pointer reads a nested field from the parsed envelope", () => {
    const [result] = evaluateMechanism(
      [{ kind: "envelope_pointer", pointer: "/completed", value: true }],
      [],
      { completed: true },
    );
    expect(result?.passed).toBe(true);
  });

  it("envelope_pointer fails when the observed value diverges", () => {
    const [result] = evaluateMechanism(
      [{ kind: "envelope_pointer", pointer: "/completed", value: true }],
      [],
      { completed: false },
    );
    expect(result?.passed).toBe(false);
  });

  it("system_prompt_includes defaults to the first request when 'request' is omitted", () => {
    const requests = [
      request([{ role: "system", content: "first system prompt" }]),
      request([{ role: "system", content: "second system prompt" }]),
    ];
    const [result] = evaluateMechanism(
      [{ kind: "system_prompt_includes", substring: "first system prompt" }],
      requests,
      null,
    );
    expect(result?.passed).toBe(true);
  });

  it("system_prompt_includes targets an explicit later request, not just the first", () => {
    const requests = [
      request([{ role: "system", content: "SUMMARY_SYSTEM: compact this" }]),
      request([{ role: "system", content: "You are Lohra, a self-improving AI assistant." }]),
    ];
    const [failsAtFirst] = evaluateMechanism(
      [{ kind: "system_prompt_includes", substring: "self-improving", request: 1 }],
      requests,
      null,
    );
    expect(failsAtFirst?.passed).toBe(false);
    const [passesAtSecond] = evaluateMechanism(
      [{ kind: "system_prompt_includes", substring: "self-improving", request: 2 }],
      requests,
      null,
    );
    expect(passesAtSecond?.passed).toBe(true);
  });

  it("message_content_includes finds a substring in any message, not just the last tool result", () => {
    const requests = [
      request([
        { role: "system", content: "identity" },
        { role: "user", content: "(resumo da conversa anterior a seguir)" },
        { role: "assistant", content: "Key Decisions: never use rm -rf." },
        { role: "user", content: "continue" },
      ]),
    ];
    const [result] = evaluateMechanism(
      [{ kind: "message_content_includes", request: 1, substring: "never use rm -rf" }],
      requests,
      null,
    );
    expect(result?.passed).toBe(true);
  });

  it("message_content_includes fails when no message in the request carries the substring", () => {
    const requests = [request([{ role: "user", content: "unrelated" }])];
    const [result] = evaluateMechanism(
      [{ kind: "message_content_includes", request: 1, substring: "never use rm -rf" }],
      requests,
      null,
    );
    expect(result?.passed).toBe(false);
  });
});

describe("refuseNetworkInCi", () => {
  it("does nothing without --provider, regardless of CI", () => {
    expect(() => {
      refuseNetworkInCi(undefined, { CI: "true" });
    }).not.toThrow();
  });

  it("throws for CI='true' (GitHub Actions' own value) with --provider set", () => {
    expect(() => {
      refuseNetworkInCi("openrouter", { CI: "true" });
    }).toThrow(/nunca roda em CI/);
  });

  it("throws for CI='1' (other CI providers' convention), not just the exact string 'true'", () => {
    expect(() => {
      refuseNetworkInCi("openrouter", { CI: "1" });
    }).toThrow(/nunca roda em CI/);
  });

  it("throws for GITHUB_ACTIONS='true' even when CI is unset", () => {
    expect(() => {
      refuseNetworkInCi("openrouter", { GITHUB_ACTIONS: "true" });
    }).toThrow(/nunca roda em CI/);
  });

  it("does not throw when CI is absent, empty, '0' or 'false'", () => {
    expect(() => {
      refuseNetworkInCi("openrouter", {});
    }).not.toThrow();
    expect(() => {
      refuseNetworkInCi("openrouter", { CI: "" });
    }).not.toThrow();
    expect(() => {
      refuseNetworkInCi("openrouter", { CI: "0" });
    }).not.toThrow();
    expect(() => {
      refuseNetworkInCi("openrouter", { CI: "false" });
    }).not.toThrow();
    expect(() => {
      refuseNetworkInCi("openrouter", { CI: "FALSE" });
    }).not.toThrow();
  });
});

describe("evaluateOutcome", () => {
  it("passes when the output matches the expected regex", () => {
    const result = evaluateOutcome({ question: "q", expect: "^STUB-OK$" }, "STUB-OK");
    expect(result).toEqual({ question: "q", verdict: "pass" });
  });

  it("fails when the output does not match", () => {
    const result = evaluateOutcome({ question: "q", expect: "^STUB-OK$" }, "something else");
    expect(result.verdict).toBe("fail");
  });

  it("reports no-signal when there is no output to judge", () => {
    const result = evaluateOutcome({ question: "q", expect: "anything" }, null);
    expect(result.verdict).toBe("no-signal");
  });

  it("throws with a cause when expect is not a valid regex", () => {
    expect(() => evaluateOutcome({ question: "q", expect: "(" }, "x")).toThrow(/regex válida/);
  });
});

describe("incremental results.jsonl", () => {
  it("appends one line per call without clobbering previous lines", () => {
    const path = join(tempDir(), "results.jsonl");
    resetResultsFile(path);
    const lineA: EvalResultLine = {
      id: "a",
      mode: "stub",
      exitCode: 0,
      timedOut: false,
      error: null,
      apiCalls: 1,
      usageTotal: null,
      budgetTokens: 10,
      budgetExceeded: false,
      mechanism: [],
      mechanismOk: true,
      outcome: null,
      elapsedMs: 1,
    };
    const lineB: EvalResultLine = { ...lineA, id: "b" };
    appendResultLine(path, lineA);
    appendResultLine(path, lineB);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0] ?? "") as { id: string }).id).toBe("a");
    expect((JSON.parse(lines[1] ?? "") as { id: string }).id).toBe("b");
  });

  it("resetResultsFile truncates a stale file from a previous run before a new batch starts", () => {
    const path = join(tempDir(), "results.jsonl");
    appendResultLine(path, {
      id: "stale",
      mode: "stub",
      exitCode: 0,
      timedOut: false,
      error: null,
      apiCalls: 0,
      usageTotal: null,
      budgetTokens: 1,
      budgetExceeded: false,
      mechanism: [],
      mechanismOk: true,
      outcome: null,
      elapsedMs: 0,
    });
    resetResultsFile(path);
    expect(readFileSync(path, "utf8")).toBe("");
  });
});

const CASE_A: EvalCase = {
  id: "case-a",
  input: "hi",
  stubScript: { default: [{ kind: "text", content: "OK-A" }] },
  mechanism: [{ kind: "request_count", count: 1 }],
  outcome: { question: "q", expect: "OK-A" },
  budgetTokens: 100,
};
const CASE_B: EvalCase = { ...CASE_A, id: "case-b", outcome: { question: "q", expect: "OK-A" } };
const CASE_C: EvalCase = { ...CASE_A, id: "case-c" };

function fakeSessionResult(overrides: Partial<EvalSessionResult> = {}): EvalSessionResult {
  return {
    exitCode: 0,
    timedOut: false,
    envelope: { output: "OK-A", error: null, api_calls: 1 },
    envelopeParseError: null,
    stderr: "",
    requests: [request([{ role: "system", content: "x" }])],
    ...overrides,
  };
}

describe("runCaseToResultLine", () => {
  it("marks mechanismOk true when every assertion passes", async () => {
    const line = await runCaseToResultLine(CASE_A, { cliPath: "unused", timeoutMs: 1000 }, () =>
      Promise.resolve(fakeSessionResult()),
    );
    expect(line.mechanismOk).toBe(true);
    expect(line.outcome?.verdict).toBe("pass");
  });

  it("marks mechanismOk false when an assertion fails", async () => {
    const line = await runCaseToResultLine(
      { ...CASE_A, mechanism: [{ kind: "request_count", count: 99 }] },
      { cliPath: "unused", timeoutMs: 1000 },
      () => Promise.resolve(fakeSessionResult()),
    );
    expect(line.mechanismOk).toBe(false);
  });

  it("skips the mechanism oracle in provider mode instead of faking a verdict", async () => {
    const line = await runCaseToResultLine(
      CASE_A,
      { cliPath: "unused", timeoutMs: 1000, provider: "openrouter" },
      () => Promise.resolve(fakeSessionResult({ requests: [] })),
    );
    expect(line.mechanism).toEqual([]);
    expect(line.mechanismOk).toBe("skipped");
    expect(line.mechanismSkippedReason).toMatch(/modo provider/);
    expect(line.mode).toBe("provider");
    expect(line.provider).toBe("openrouter");
  });

  it("flags budgetExceeded when measured usage exceeds the case's budget", async () => {
    const line = await runCaseToResultLine(CASE_A, { cliPath: "unused", timeoutMs: 1000 }, () =>
      Promise.resolve(
        fakeSessionResult({
          envelope: {
            output: "OK-A",
            error: null,
            api_calls: 1,
            usage_total: { input_tokens: 90, output_tokens: 90 },
          },
        }),
      ),
    );
    expect(line.budgetExceeded).toBe(true);
    expect(line.usageTotal).toEqual({ inputTokens: 90, outputTokens: 90 });
  });
});

describe("runCaseSafely", () => {
  it("never throws: a session that rejects becomes an error result line", async () => {
    const line = await runCaseSafely(CASE_A, { cliPath: "unused", timeoutMs: 1000 }, () => {
      throw new Error("boom: spawn failed");
    });
    expect(line.error).toContain("boom: spawn failed");
    expect(line.mechanismOk).toBe(false);
  });

  it("marks mechanismOk 'skipped', never false, when a provider-mode session rejects", async () => {
    const line = await runCaseSafely(
      CASE_A,
      { cliPath: "unused", timeoutMs: 1000, provider: "openrouter" },
      () => {
        throw new Error("boom: network unreachable");
      },
    );
    expect(line.error).toContain("boom: network unreachable");
    expect(line.mechanismOk).toBe("skipped");
  });
});

describe("runBatch", () => {
  it("keeps every line written before a later case's session throws (no lost progress)", async () => {
    const path = join(tempDir(), "results.jsonl");
    let calls = 0;
    const lines = await runBatch(
      [CASE_A, CASE_B, CASE_C],
      { cliPath: "unused", timeoutMs: 1000, resultsPath: path },
      (kase) => {
        calls += 1;
        if (kase.id === "case-b") throw new Error("simulated crash mid-batch");
        return Promise.resolve(fakeSessionResult());
      },
    );
    expect(calls).toBe(3);
    expect(lines.map((line) => line.id)).toEqual(["case-a", "case-b", "case-c"]);
    expect(lines[1]?.error).toContain("simulated crash mid-batch");
    const onDisk = readFileSync(path, "utf8").trim().split("\n");
    expect(onDisk).toHaveLength(3);
    expect((JSON.parse(onDisk[0] ?? "") as { id: string }).id).toBe("case-a");
    expect((JSON.parse(onDisk[2] ?? "") as { id: string }).id).toBe("case-c");
  });
});

describe("buildSummary", () => {
  it("counts mechanism and outcome passes and carries per-case tokens", () => {
    const lineA: EvalResultLine = {
      id: "a",
      mode: "stub",
      exitCode: 0,
      timedOut: false,
      error: null,
      apiCalls: 1,
      usageTotal: { inputTokens: 10, outputTokens: 5 },
      budgetTokens: 100,
      budgetExceeded: false,
      mechanism: [],
      mechanismOk: true,
      outcome: { question: "q", verdict: "pass" },
      elapsedMs: 1,
    };
    const lineB: EvalResultLine = {
      ...lineA,
      id: "b",
      mechanismOk: false,
      outcome: { question: "q", verdict: "fail" },
    };
    const summary = buildSummary("stub", undefined, [lineA, lineB]);
    expect(summary.total).toBe(2);
    expect(summary.mechanismPassCount).toBe(1);
    expect(summary.mechanismSkippedCount).toBe(0);
    expect(summary.outcomePassCount).toBe(1);
    expect(summary.cases.map((entry) => entry.totalTokens)).toEqual([15, 15]);
  });

  it("counts 'skipped' mechanism verdicts separately from passes — never as a pass", () => {
    const lineA: EvalResultLine = {
      id: "a",
      mode: "provider",
      provider: "openrouter",
      exitCode: 0,
      timedOut: false,
      error: null,
      apiCalls: 1,
      usageTotal: null,
      budgetTokens: 100,
      budgetExceeded: false,
      mechanism: [],
      mechanismOk: "skipped",
      outcome: { question: "q", verdict: "pass" },
      elapsedMs: 1,
    };
    const summary = buildSummary("provider", "openrouter", [lineA]);
    expect(summary.mechanismPassCount).toBe(0);
    expect(summary.mechanismSkippedCount).toBe(1);
  });
});

describe("parseArgs --tag", () => {
  it("is absent by default", () => {
    expect(parseArgs([]).tag).toBeUndefined();
  });

  it("parses a value and pairs freely with --provider/--set/--cli", () => {
    const args = parseArgs([
      "--provider",
      "openrouter",
      "--set",
      "dev",
      "--cli",
      "dist/cli.js",
      "--tag",
      "antes-585",
    ]);
    expect(args.tag).toBe("antes-585");
    expect(args.provider).toBe("openrouter");
    expect(args.set).toBe("dev");
    expect(args.cli).toBe("dist/cli.js");
  });

  it("throws without a value", () => {
    expect(() => parseArgs(["--tag"])).toThrow(/--tag precisa de um valor/);
  });
});
