// Issue #401 (M8-5): `createNoticesSink` unifies the ad hoc `console.warn`
// closures every composition root built for a `StateWarning`/plain-string
// warning into ONE adapter that keeps the existing fallback AND ALSO
// records the same warning durably in `operator_notices`
// (`src/state/notices-repository.ts`, issue #400).
//
// `worktree-segura` §7: `createNoticesSink` is a symbol new to this branch
// — imported directly (not via `import * as`) — so its `test(red)`
// companion commit ships a throwing stub in `src/workflow/notices-sink.ts`
// alongside these tests, matching the REAL exported signature (never a
// zero-arity placeholder: a wrong arity is a `tsc` error, not a red test).
//
// The last describe block is the fiação test the issue asks for, molded on
// `tests/chat-audit-trail-wiring.test.ts` (real `runChat`, a stub HTTP
// server standing in for the provider, HOME in a tmpdir): it forces a REAL
// `STALE_FENCE_WRITE` by intercepting `WorkflowRepository.prototype.
// putRunState`'s very first (launch-line) call and presenting a fence one
// below the one it was just given, then reads the notice back through a
// SECOND `openStateDatabase` connection, and asserts stderr's
// `workflow: STALE_FENCE_WRITE …` line is exactly the one
// `tests/workflow-durable-roots.test.ts:285` already pins — unchanged.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runChat } from "../src/commands/chat.js";
import { registerProvider } from "../src/providers/registry.js";
import {
  LockRepository,
  NoticesRepository,
  openStateDatabase,
  WorkflowRepository,
  type RunStateFields,
} from "../src/state/index.js";
import { createNoticesSink, type NoticesSinkRepository } from "../src/workflow/notices-sink.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function tempDbPath(): string {
  const root = mkdtempSync(join(tmpdir(), "lohra-notices-sink-"));
  roots.push(root);
  return join(root, "state.db");
}

describe("createNoticesSink — warn(message)", () => {
  it("calls the fallback and records a known-prefix message under the global scope", () => {
    const connection = openStateDatabase(tempDbPath());
    try {
      const repository = new NoticesRepository(connection.database);
      const fallbackCalls: string[] = [];
      const sink = createNoticesSink({
        repository,
        fallback: (message) => {
          fallbackCalls.push(message);
        },
      });
      sink.warn("audit append failed for run r-1: boom");
      expect(fallbackCalls).toEqual(["audit append failed for run r-1: boom"]);
      const page = repository.list({ scope: "global" });
      expect(page.notices).toHaveLength(1);
      expect(page.notices[0]?.kind).toBe("audit_sink_failure");
      expect(page.notices[0]?.scope).toBe("global");
      expect(sink.stats().dropped).toBe(0);
    } finally {
      connection.close();
    }
  });

  it("falls back to 'unknown' for a message matching no known marker", () => {
    const connection = openStateDatabase(tempDbPath());
    try {
      const repository = new NoticesRepository(connection.database);
      const sink = createNoticesSink({ repository, fallback: () => undefined });
      sink.warn("some other, never-classified warning");
      const page = repository.list({ scope: "global" });
      expect(page.notices[0]?.kind).toBe("unknown");
    } finally {
      connection.close();
    }
  });

  const MARKER_CASES: ReadonlyArray<readonly [message: string, kind: string]> = [
    ["audit append failed for run r-2: writer closed", "audit_sink_failure"],
    ["audit queue overflow for run r-3", "queue_overflow"],
    [
      "workflow: run r-4 stays paused after 5 auto-resume attempt(s); " +
        "resume it manually with run_workflow(resume_run_id=...)",
      "resume_attempts_exhausted",
    ],
    // Issue #410 (M8-8): the three `audit-trail.ts` producers the previous
    // mapa left as `unknown` — byte-for-byte prefixes of :180/:213, :61,
    // :79, matched by substring before the run id/details that follow.
    ["audit sink failed permanently for run r-5", "audit_sink_failure"],
    ["audit unavailable for run r-6: writer is closed", "audit_sink_failure"],
    ["audit sanitizer failed for run r-7: boom", "audit_sink_failure"],
  ];

  it.each(MARKER_CASES)("classifies %s as %s", (message, kind) => {
    const connection = openStateDatabase(tempDbPath());
    try {
      const repository = new NoticesRepository(connection.database);
      const sink = createNoticesSink({ repository, fallback: () => undefined });
      sink.warn(message);
      const page = repository.list({ scope: "global" });
      expect(page.notices[0]?.kind).toBe(kind);
    } finally {
      connection.close();
    }
  });

  it("an append that throws is dropped, counted, and never propagates — the fallback still fires", () => {
    const throwing: NoticesSinkRepository = {
      append: () => {
        throw new Error("t401 repository boom");
      },
    };
    const fallbackCalls: string[] = [];
    const sink = createNoticesSink({
      repository: throwing,
      fallback: (message) => {
        fallbackCalls.push(message);
      },
    });
    expect(() => {
      sink.warn("anything");
    }).not.toThrow();
    expect(fallbackCalls).toEqual(["anything"]);
    expect(sink.stats().dropped).toBe(1);
  });

  it("an append refused (returns null) is also dropped and counted", () => {
    const refusing: NoticesSinkRepository = { append: () => null };
    const fallbackCalls: string[] = [];
    const sink = createNoticesSink({
      repository: refusing,
      fallback: (message) => {
        fallbackCalls.push(message);
      },
    });
    sink.warn("anything");
    expect(fallbackCalls).toEqual(["anything"]);
    expect(sink.stats().dropped).toBe(1);
  });
});

describe("createNoticesSink — warnState(warning)", () => {
  it(
    "records kind: stale_fence_write under scope run:<id>, with the CURRENT fence " +
      "— not the warning's stale one — and calls the fallback once",
    () => {
      const connection = openStateDatabase(tempDbPath());
      try {
        const locks = new LockRepository(connection.database);
        const repository = new NoticesRepository(connection.database);
        const currentFence = locks.acquireRunLease("run-9", "holder-a", 1000, 100);
        if (currentFence === null) throw new Error("expected a lease token");
        const fallbackCalls: string[] = [];
        const sink = createNoticesSink({
          repository,
          fallback: (message) => {
            fallbackCalls.push(message);
          },
          ownership: (runId) => {
            const fence = locks.runFenceOf(runId);
            return fence === null ? null : { fence, holder: "holder-a", now: 1000 };
          },
        });
        const staleFence = Number(currentFence) - 1;
        sink.warnState({ cause: "STALE_FENCE_WRITE", runId: "run-9", fence: staleFence });
        expect(fallbackCalls).toEqual([
          `workflow: STALE_FENCE_WRITE run=run-9 fence=${String(staleFence)}`,
        ]);
        const page = repository.list({ scope: "run:run-9" });
        expect(page.notices).toHaveLength(1);
        expect(page.notices[0]?.kind).toBe("stale_fence_write");
        expect(page.notices[0]?.fence).toBe(Number(currentFence));
        expect(sink.stats().dropped).toBe(0);
      } finally {
        connection.close();
      }
    },
  );

  it(
    "falls back to scope:global (never dropped) when `ownership` cannot resolve the run " +
      "— issue #410: the notice survives without a dono instead of being lost",
    () => {
      const connection = openStateDatabase(tempDbPath());
      try {
        const repository = new NoticesRepository(connection.database);
        const fallbackCalls: string[] = [];
        const sink = createNoticesSink({
          repository,
          fallback: (message) => {
            fallbackCalls.push(message);
          },
          ownership: () => null,
        });
        sink.warnState({ cause: "STALE_FENCE_WRITE", runId: "run-nobody-owns", fence: 3 });
        expect(fallbackCalls).toHaveLength(1);
        expect(sink.stats().dropped).toBe(0);
        expect(sink.stats().fallback_global).toBe(1);
        expect(repository.list({ scope: "run:run-nobody-owns" }).notices).toHaveLength(0);
        const globalPage = repository.list({ scope: "global" });
        expect(globalPage.notices).toHaveLength(1);
        expect(globalPage.notices[0]?.kind).toBe("stale_fence_write");
        expect(globalPage.notices[0]?.message).toContain("run-nobody-owns");
      } finally {
        connection.close();
      }
    },
  );

  it("falls back to scope:global (never dropped) when no `ownership` resolver was given at all", () => {
    const connection = openStateDatabase(tempDbPath());
    try {
      const repository = new NoticesRepository(connection.database);
      const fallbackCalls: string[] = [];
      const sink = createNoticesSink({
        repository,
        fallback: (message) => {
          fallbackCalls.push(message);
        },
      });
      sink.warnState({ cause: "STALE_FENCE_WRITE", runId: "run-none", fence: 1 });
      expect(fallbackCalls).toHaveLength(1);
      expect(sink.stats().dropped).toBe(0);
      expect(sink.stats().fallback_global).toBe(1);
      const globalPage = repository.list({ scope: "global" });
      expect(globalPage.notices).toHaveLength(1);
      expect(globalPage.notices[0]?.message).toContain("run-none");
    } finally {
      connection.close();
    }
  });

  it(
    "a real cross-process takeover — process B acquires the lease `acquireRunLease` gave " +
      "up on process A — refuses A's run-scoped append, and A's sink falls back to " +
      "scope:global where B reads it back with the run_id in the message",
    () => {
      const dbPath = tempDbPath();
      const connectionA = openStateDatabase(dbPath);
      const connectionB = openStateDatabase(dbPath);
      try {
        const locksA = new LockRepository(connectionA.database);
        const locksB = new LockRepository(connectionB.database);
        const repositoryA = new NoticesRepository(connectionA.database);
        const repositoryB = new NoticesRepository(connectionB.database);

        const fenceA = locksA.acquireRunLease("run-10", "holder-a", 1_000, 100);
        if (fenceA === null) throw new Error("expected process A to get the lease first");
        // Process A's lease expires at 1_100; B acquires well past that —
        // `acquireRunLease` deletes A's expired row and takes over with its
        // own holder, bumping the shared fence.
        const fenceB = locksB.acquireRunLease("run-10", "holder-b", 2_000, 100);
        if (fenceB === null) throw new Error("expected process B to take the lease over");
        expect(Number(fenceB)).toBeGreaterThan(Number(fenceA));

        const fallbackCalls: string[] = [];
        const sinkA = createNoticesSink({
          repository: repositoryA,
          fallback: (message) => {
            fallbackCalls.push(message);
          },
          // Mirrors the production resolver shape (`chat.ts:274-279`,
          // `dashboard.ts:265-270`): it resolves the CURRENT fence but
          // always assumes THIS process's own holder id — it never asks
          // "who holds it now". After B's takeover the fence moved but the
          // holder reported here is still "holder-a", so `NoticesRepository`
          // refuses the run-scoped append below (real STALE_FENCE_WRITE).
          ownership: (runId) => {
            const fence = locksA.runFenceOf(runId);
            return fence === null ? null : { fence: Number(fence), holder: "holder-a", now: 2_000 };
          },
        });
        sinkA.warnState({ cause: "STALE_FENCE_WRITE", runId: "run-10", fence: Number(fenceA) });
        expect(fallbackCalls).toHaveLength(1);
        expect(sinkA.stats().dropped).toBe(0);
        expect(sinkA.stats().fallback_global).toBe(1);
        expect(repositoryA.list({ scope: "run:run-10" }).notices).toHaveLength(0);

        // Read back through B's OWN connection — the durable trail survives
        // the takeover even though A no longer owns the run.
        const page = repositoryB.list({ scope: "global" });
        expect(page.notices).toHaveLength(1);
        expect(page.notices[0]?.kind).toBe("stale_fence_write");
        expect(page.notices[0]?.scope).toBe("global");
        expect(page.notices[0]?.message).toContain("run-10");
      } finally {
        connectionA.close();
        connectionB.close();
      }
    },
  );
});

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error === undefined) resolvePromise();
      else reject(error);
    });
  });
}

function chatResponse(
  id: string,
  message: Readonly<Record<string, unknown>>,
  finishReason: string,
): Readonly<Record<string, unknown>> {
  return {
    id: `chatcmpl-${id}`,
    object: "chat.completion",
    created: 0,
    model: "t401-notices-sink-model",
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

function workflowSpec(): Readonly<Record<string, unknown>> {
  return {
    meta: { name: "notices-sink-fiacao" },
    nodes: [{ id: "a", type: "agent", prompt: "do it" }],
  };
}

/** Turn 1: run_workflow. Turn 2 (tool result already in history): plain
 * text — the same "the launch line is written synchronously inside the
 * run_workflow call itself" shape `workflow-durable-chat.test.ts` and
 * `tests/chat-audit-trail-wiring.test.ts` already rely on; no leaf ever
 * needs to actually run for this test's STALE_FENCE_WRITE to fire. */
function startServer(): Server {
  let mainCalls = 0;
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      mainCalls += 1;
      const payload =
        mainCalls === 1
          ? chatResponse(
              "main-1",
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-run-workflow",
                    type: "function",
                    function: {
                      name: "run_workflow",
                      arguments: JSON.stringify({ spec: workflowSpec() }),
                    },
                  },
                ],
              },
              "tool_calls",
            )
          : chatResponse("main-2", { role: "assistant", content: "workflow started" }, "stop");
      const text = JSON.stringify(payload);
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(text)),
      });
      response.end(text);
    });
  });
}

describe("notices-sink fiação (#401): runChat, a real STALE_FENCE_WRITE, and a second connection", () => {
  it(
    "a STALE_FENCE_WRITE during run_workflow lands in operator_notices, read by a " +
      "DIFFERENT connection — stderr keeps the exact pinned line, unchanged",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "lohra-t401-fiacao-"));
      roots.push(root);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      let capturedRunId = "";
      let realFence = -1;
      // Captured before `vi.spyOn` replaces the prototype slot; always
      // invoked below via `.call(this, …)`, so the unbound reference is
      // never called with the wrong receiver.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const originalPutRunState = WorkflowRepository.prototype.putRunState;
      vi.spyOn(WorkflowRepository.prototype, "putRunState").mockImplementationOnce(function (
        this: WorkflowRepository,
        runId: string,
        fields: RunStateFields,
      ): boolean {
        capturedRunId = runId;
        realFence = fields.fence ?? -1;
        return originalPutRunState.call(this, runId, { ...fields, fence: realFence - 1 });
      });
      const server = startServer();
      await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
      try {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("missing test port");
        const provider = "t401-notices-sink-probe";
        registerProvider({
          name: provider,
          apiMode: "chat_completions",
          aliases: [],
          displayName: "T401 notices sink probe",
          description: "Local in-memory composition-root probe (issue #401).",
          signupUrl: "",
          envVars: [],
          baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
          modelsUrl: "",
          requiresApiKey: false,
          supportsVision: false,
          fallbackModels: ["t401-notices-sink-model"],
          defaultMaxTokens: 256,
          defaultAuxModel: "",
        });
        const result = await runChat({
          input: "run the notices-sink workflow",
          flags: new Map<string, string | true>([
            ["--provider", provider],
            ["--model", "t401-notices-sink-model"],
            ["--json", true],
            ["--no-input", true],
          ]),
          environment: { HOME: root, PATH: process.env.PATH ?? "" },
          home: join(root, ".lohra"),
          codexHome: join(root, ".codex"),
          cwd: root,
        });
        expect(result.code).toBe(0);
        expect(capturedRunId).not.toBe("");
        const matched = warnSpy.mock.calls
          .map((call) => String(call[0]))
          .filter((message) => message.startsWith("workflow: STALE_FENCE_WRITE "));
        expect(matched).toEqual([
          `workflow: STALE_FENCE_WRITE run=${capturedRunId} fence=${String(realFence - 1)}`,
        ]);
        const readback = openStateDatabase(join(root, ".lohra", "state.db"));
        try {
          const notices = new NoticesRepository(readback.database);
          const page = notices.list({ scope: `run:${capturedRunId}` });
          expect(page.notices).toHaveLength(1);
          expect(page.notices[0]?.kind).toBe("stale_fence_write");
          expect(page.notices[0]?.fence).toBe(realFence);
        } finally {
          readback.close();
        }
      } finally {
        await closeServer(server);
      }
    },
  );
});
