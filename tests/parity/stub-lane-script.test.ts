import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { awaitLatch, startStub } from "../../scripts/parity/stub/server.js";
import type { StubRuntime } from "../../scripts/parity/stub/types.js";
import type { StubLaneStep } from "../../scripts/parity/types.js";

// One server for the whole file, reconfigured per test by mutating the
// shared runtime object in place — avoids the repeated bind/unbind-the-
// same-port churn that made this file flaky under vitest's fast sequential
// execution (a distinct issue from the lane-script logic itself, and the
// same class of port-11434-under-load flakiness already carried as debt
// for tests/parity/stub-driver.test.ts).
const HEADER_ALLOWLIST = [
  "authorization",
  "accept",
  "content-type",
  "host",
  "x-stainless-retry-count",
  "accept-encoding",
  "accept-language",
  "connection",
  "content-length",
  "user-agent",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-dest",
];

let runtime: StubRuntime;
let server: Awaited<ReturnType<typeof startStub>>;
let stubPort: number;
const roots: string[] = [];
let projectedLog: string;
let rawLog: string;

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "lohra-stub-lane-"));
  roots.push(root);
  projectedLog = join(root, "projected.jsonl");
  rawLog = join(root, "raw.jsonl");
  runtime = {
    fixture: "chat-lane-script",
    state: "up-with-models",
    scenario: "t13-lane-test",
    side: "candidate",
    comparedHeaders: [],
    excludedHeaders: HEADER_ALLOWLIST,
    projectedLog,
    rawLog,
    failures: [],
    sequence: [],
    toolSequence: [],
    laneSteps: {},
    laneStepIndex: new Map(),
    latches: new Map(),
    posts: 0,
    requests: 0,
  };
  server = await startStub(runtime, 0);
  stubPort = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
    server.closeAllConnections();
  });
});

afterEach(() => {
  while (roots.length > 1) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function reset(laneSteps: Readonly<Record<string, readonly StubLaneStep[]>>): void {
  runtime.laneSteps = laneSteps;
  runtime.laneStepIndex.clear();
  runtime.latches.clear();
  runtime.failures.length = 0;
  runtime.posts = 0;
  runtime.requests = 0;
  runtime.sequence.length = 0;
  writeFileSync(projectedLog, "");
  writeFileSync(rawLog, "");
}

function post(body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(stubPort)}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface StubCompletionJson {
  readonly choices: readonly {
    readonly finish_reason: string;
    readonly message: {
      readonly content: string | null;
      readonly tool_calls?: readonly {
        readonly function: { readonly name: string; readonly arguments: string };
      }[];
    };
  }[];
  readonly error?: { readonly message: string };
}

async function postJson(body: unknown): Promise<StubCompletionJson> {
  return (await post(body)).json() as Promise<StubCompletionJson>;
}

function projectedLines<T>(): T[] {
  return readFileSync(projectedLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as T);
}

const CHILD_SYSTEM =
  "You are an isolated subagent spawned to complete one specific task. You have no access.";
const PARENT_SYSTEM = "You are Lohra, a self-improving AI assistant.";

describe("chat-lane-script fixture", () => {
  it("discriminates parent vs child purely from the system message the product already sends", async () => {
    reset({});
    await post({
      model: "m",
      messages: [
        { role: "system", content: PARENT_SYSTEM },
        { role: "user", content: "SCEN:p hi" },
      ],
    });
    await post({
      model: "m",
      messages: [
        { role: "system", content: CHILD_SYSTEM },
        { role: "user", content: "SCEN:p hi" },
      ],
    });
    const lines = projectedLines<{ isChild: boolean }>();
    expect(lines[0]?.isChild).toBe(false);
    expect(lines[1]?.isChild).toBe(true);
  });

  it("falls back to lane 'default' when no SCEN: tag is present, and extracts it when present", async () => {
    reset({});
    await post({ model: "m", messages: [{ role: "user", content: "no tag here" }] });
    await post({ model: "m", messages: [{ role: "user", content: "SCEN:alpha do the thing" }] });
    const lines = projectedLines<{ lane: string }>();
    expect(lines[0]?.lane).toBe("default");
    expect(lines[1]?.lane).toBe("alpha");
  });

  it("advances each lane's step list independently, regardless of interleaving with another lane", async () => {
    reset({
      main: [
        { kind: "text", content: "MAIN-1" },
        { kind: "text", content: "MAIN-2" },
      ],
      kid: [{ kind: "text", content: "KID-1" }],
    });
    const main1 = await postJson({
      model: "m",
      messages: [{ role: "user", content: "SCEN:main a" }],
    });
    const kid1 = await postJson({
      model: "m",
      messages: [{ role: "user", content: "SCEN:kid b" }],
    });
    const main2 = await postJson({
      model: "m",
      messages: [{ role: "user", content: "SCEN:main c" }],
    });
    expect(main1.choices[0]?.message.content).toBe("MAIN-1");
    expect(kid1.choices[0]?.message.content).toBe("KID-1");
    expect(main2.choices[0]?.message.content).toBe("MAIN-2");
  });

  it("scripts a tool_calls step matching a spawn_session-shaped call", async () => {
    reset({
      main: [
        {
          kind: "tool_calls",
          calls: [{ name: "spawn_session", argumentsRaw: '{"prompt":"SCEN:kid do it"}' }],
        },
      ],
    });
    const response = await postJson({
      model: "m",
      messages: [{ role: "user", content: "SCEN:main go" }],
    });
    expect(response.choices[0]?.finish_reason).toBe("tool_calls");
    expect(response.choices[0]?.message.tool_calls?.[0]?.function.name).toBe("spawn_session");
    expect(response.choices[0]?.message.tool_calls?.[0]?.function.arguments).toBe(
      '{"prompt":"SCEN:kid do it"}',
    );
  });

  // Mirrors the Evaluator's own harness-fake_upstream.py __SUB__ sentinel
  // (_sub_ids/_resolve): resolved from sub_id values the stub already sees
  // in role:"tool" message content earlier in the SAME request's history —
  // no product cooperation, purely observational, same as the Evaluator's
  // reference implementation. Lets a manifest script a collect_session/
  // steer_session call against a sub_id it can't know ahead of authoring
  // time.
  describe("__SUB__ sentinel resolution (mirrors the Evaluator's harness)", () => {
    it("resolves __SUB__ to the most recently seen sub_id from a prior tool message in this request", async () => {
      reset({
        main: [
          {
            kind: "tool_calls",
            calls: [{ name: "collect_session", argumentsRaw: '{"sub_id":"__SUB__","wait":true}' }],
          },
        ],
      });
      const response = await postJson({
        model: "m",
        messages: [
          { role: "user", content: "SCEN:main go" },
          { role: "assistant", content: null, tool_calls: [] },
          {
            role: "tool",
            content: '{"ok": true, "sub_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
          },
        ],
      });
      expect(response.choices[0]?.message.tool_calls?.[0]?.function.arguments).toBe(
        '{"sub_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","wait":true}',
      );
    });

    it("resolves __SUB2__ to the second sub_id seen, in order of first appearance across multiple tool messages", async () => {
      reset({
        main: [
          {
            kind: "tool_calls",
            calls: [{ name: "collect_session", argumentsRaw: '{"sub_id":"__SUB2__"}' }],
          },
        ],
      });
      const response = await postJson({
        model: "m",
        messages: [
          { role: "user", content: "SCEN:main go" },
          { role: "tool", content: '{"sub_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' },
          { role: "tool", content: '{"sub_id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}' },
        ],
      });
      expect(response.choices[0]?.message.tool_calls?.[0]?.function.arguments).toBe(
        '{"sub_id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}',
      );
    });

    it("resolves an unmatched sentinel to the literal '__NO_SUB__' error marker, same as the Evaluator's harness", async () => {
      reset({
        main: [
          {
            kind: "tool_calls",
            calls: [{ name: "collect_session", argumentsRaw: '{"sub_id":"__SUB__"}' }],
          },
        ],
      });
      const response = await postJson({
        model: "m",
        messages: [{ role: "user", content: "SCEN:main go" }],
      });
      expect(response.choices[0]?.message.tool_calls?.[0]?.function.arguments).toBe(
        '{"sub_id":"__NO_SUB__"}',
      );
    });

    it("leaves argumentsRaw byte-for-byte unchanged when it contains no __SUB sentinel — no-op for every existing scenario", async () => {
      reset({
        main: [
          {
            kind: "tool_calls",
            calls: [{ name: "terminal", argumentsRaw: '{"command": ["sudo", "x"]}' }],
          },
        ],
      });
      const response = await postJson({
        model: "m",
        messages: [
          { role: "user", content: "SCEN:main go" },
          { role: "tool", content: '{"sub_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' },
        ],
      });
      expect(response.choices[0]?.message.tool_calls?.[0]?.function.arguments).toBe(
        '{"command": ["sudo", "x"]}',
      );
    });
  });

  it("serves an http_error step with the declared status and message", async () => {
    reset({ main: [{ kind: "http_error", status: 418, message: "T13_CANARY" }] });
    const response = await post({
      model: "m",
      messages: [{ role: "user", content: "SCEN:main go" }],
    });
    const parsed = (await response.json()) as StubCompletionJson;
    expect(response.status).toBe(418);
    expect(parsed.error?.message).toBe("T13_CANARY");
  });

  it("serves an http_error step's declared extra headers (e.g. retry-after for quota scenarios)", async () => {
    reset({
      main: [
        { kind: "http_error", status: 429, message: "slow down", headers: { "retry-after": "30" } },
      ],
    });
    const response = await post({
      model: "m",
      messages: [{ role: "user", content: "SCEN:main go" }],
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
  });

  it("omits extra headers entirely when an http_error step declares none", async () => {
    reset({ main: [{ kind: "http_error", status: 429, message: "slow down" }] });
    const response = await post({
      model: "m",
      messages: [{ role: "user", content: "SCEN:main go" }],
    });
    expect(response.headers.get("retry-after")).toBeNull();
  });

  it("forces cross-lane ordering by barrier, never by sleep: a gated request only resolves after another lane opens it", async () => {
    reset({
      waiter: [{ kind: "text", content: "RELEASED", signal: "waiter-arrived", gate: "go" }],
      // Two opener steps: the first is a plain, ungated request that
      // completes immediately — sent and fully awaited BEFORE checking the
      // waiter, so a real, complete concurrent HTTP round trip has to
      // happen in the meantime. If the waiter's gate wait were missing, its
      // own response (also un-gated at that point) would have had more
      // than enough real I/O opportunity to complete during that round
      // trip too. The second step actually opens the gate.
      opener: [
        { kind: "text", content: "PROBE" },
        { kind: "text", content: "OPENED", openGate: "go" },
      ],
    });
    let waiterResolved = false;
    const waiterPromise = post({
      model: "m",
      messages: [{ role: "user", content: "SCEN:waiter hold" }],
    }).then((r) => {
      waiterResolved = true;
      return r;
    });
    // Confirms the waiter's request has actually reached the server (fired
    // synchronously, before its own gate wait) before doing anything else —
    // real async causality, not a guess about timing.
    await awaitLatch(runtime, "waiter-arrived");

    // A full, separate, concurrent HTTP round trip on another lane — real
    // socket I/O, not a JS-only microtask tick. If the waiter's gate wait
    // were missing, this is more than enough opportunity for its response
    // to have already arrived client-side.
    await post({ model: "m", messages: [{ role: "user", content: "SCEN:opener probe" }] });
    expect(waiterResolved).toBe(false);

    await post({ model: "m", messages: [{ role: "user", content: "SCEN:opener release" }] });
    const waiterResponse = await waiterPromise;
    expect(waiterResolved).toBe(true);
    const parsed = (await waiterResponse.json()) as StubCompletionJson;
    expect(parsed.choices[0]?.message.content).toBe("RELEASED");
  });
});
