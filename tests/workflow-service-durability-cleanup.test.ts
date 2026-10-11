import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openStateDatabase, WorkflowRepository, LockRepository } from "../src/state/index.js";
import { TaintTracker } from "../src/workflow/sandbox.js";
import { WorkflowService } from "../src/workflow/service.js";
import type { ChildResult, ChildRuntime } from "../src/workflow/runtime.js";
import { spec, withLeafSandbox } from "./workflow-service-durability.fixture.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("workflow service — leaf capability sandbox cleanup", () => {
  function policyFile(root: string, body: Record<string, unknown>): string {
    const path = join(root, "workflow_policy.json");
    writeFileSync(path, JSON.stringify(body), "utf8");
    return path;
  }

  it("the leaf dispatch of a launched run carries the OPERATOR policy, not the spec", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-service-sandbox-"));
    roots.push(root);
    const readOnlyRoot = join(root, "reference");
    mkdirSync(readOnlyRoot, { recursive: true });
    const path = policyFile(root, {
      fs_allow: [{ path: readOnlyRoot, mode: "ro" }],
      egress_allow: ["docs.example.com"],
    });
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      const tracker = new TaintTracker();
      const results: { step: string; out: string }[] = [];
      const running: { service: WorkflowService | null } = { service: null };
      let runId = "";
      // A leaf asks for its dispatch WHILE the stretch is live — that is when
      // real leaves run, and it is the only place the acquisition's policy,
      // working root and taint are the live ones.
      const runtime = withLeafSandbox<ChildRuntime>({
        spawn(): string {
          const owner = running.service;
          if (owner !== null && results.length === 0) {
            // Through the wrapper the SERVICE installed on this runtime for
            // this acquisition — the path a real leaf's tools take.
            const dispatch = (name: string, args: Readonly<Record<string, unknown>>): string =>
              runtime.leafTool(1, name, args);
            const workingRoot = owner.workingRootFor(runId);
            mkdirSync(workingRoot, { recursive: true });
            const step = (label: string, out: string): void => {
              results.push({ step: label, out });
            };
            step(
              "inside-working-root",
              dispatch("write_file", { path: join(workingRoot, "note.txt") }),
            );
            step(
              "outside-every-root",
              dispatch("read_file", { path: join(root, "elsewhere.txt") }),
            );
            step("ro-root-read", dispatch("read_file", { path: join(readOnlyRoot, "a.txt") }));
            step("ro-root-write", dispatch("write_file", { path: join(readOnlyRoot, "a.txt") }));
            step("egress-denied", dispatch("web_fetch", { url: "https://evil.example.com/x" }));
            step("taint-before", String(tracker.tainted));
            step("egress-allowed", dispatch("web_fetch", { url: "https://DOCS.example.com/x" }));
            step("taint-after", String(tracker.tainted));
            step("tainted-fs", dispatch("read_file", { path: join(readOnlyRoot, "a.txt") }));
            step("tainted-egress", dispatch("web_fetch", { url: "https://docs.example.com/x" }));
          }
          return "leaf-1";
        },
        collect: (): ChildResult => ({
          status: "complete",
          output: { answer: "ok" },
          usage: {
            inputTokens: 3,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
          },
        }),
        steer: () => undefined,
        cancel: () => undefined,
      });
      const service = new WorkflowService({
        runtime,
        policyPath: path,
        taintTracker: tracker,
        homeRoot: root,
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      running.service = service;
      // a spec that TRIES to widen its own capability changes nothing
      const started = service.start({
        meta: { name: "durable", fs_allow: ["/"], egress_allow: ["*"] },
        nodes: [{ id: "a", type: "agent", prompt: "do it" }],
      });
      if ("error" in started) throw new Error(started.error);
      runId = started.run_id;
      await service.status(started.run_id, true);
      expect(results).toEqual([
        // inside the run's own scratch root: allowed
        { step: "inside-working-root", out: "allowed:write_file" },
        // outside every root: exact denial, and the SPEC's fs_allow ["/"] did
        // not widen it — the policy is the operator file, only
        {
          step: "outside-every-root",
          out: "ERROR: path is outside the workflow working scope (sandbox denied)",
        },
        // under a read-only operator root: read ok, write refused with its own text
        { step: "ro-root-read", out: "allowed:read_file" },
        {
          step: "ro-root-write",
          out: "ERROR: path is under a read-only workflow root (sandbox denied the write)",
        },
        // egress: exact host match only; the spec's "*" widened nothing
        {
          step: "egress-denied",
          out: "ERROR: host is not in the workflow egress allowlist (sandbox denied)",
        },
        { step: "taint-before", out: "false" },
        // the allowed fetch runs AND taints the session
        { step: "egress-allowed", out: "allowed:web_fetch" },
        { step: "taint-after", out: "true" },
        // taint is live inside the SAME stretch: fs and egress both close
        { step: "tainted-fs", out: "ERROR: tainted run: filesystem access is disabled for leaves" },
        { step: "tainted-egress", out: "ERROR: tainted run: web egress is disabled for leaves" },
      ]);
      // a denied call never reached the base dispatch
      expect(runtime.baseCalls()).toEqual(["write_file", "read_file", "web_fetch"]);
      // and the taint the leaf picked up landed on THIS stretch's durable row
      expect(
        Number((repository.getRunState(started.run_id) as Record<string, unknown>).tainted),
      ).toBe(1);
    } finally {
      try {
        connection.close();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("installs one sandbox per ACQUISITION and disposes only its own", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-service-sandbox-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    let settleSecond: (() => Promise<void>) | null = null;
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const ownership = { fence: 0 as number, holder: "test", now: 1000 };
      // The SECOND acquisition's leaf stays in flight, so stretch 2 is current
      // while we ask stretch 1's retired wrapper for capability.
      let openSecond!: () => void;
      const secondLeaf = new Promise<void>((resolveLeaf) => {
        openSecond = resolveLeaf;
      });
      let spawns = 0;
      const runtime = withLeafSandbox({
        spawn: (): string => {
          spawns += 1;
          return `leaf-${String(spawns)}`;
        },
        collect: async (id: string): Promise<ChildResult> => {
          if (id === "leaf-2") await secondLeaf;
          return {
            status: "complete",
            output: { answer: "ok" },
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
            },
          };
        },
        steer: (): void => undefined,
        cancel: (): void => undefined,
      });
      const service = new WorkflowService({
        runtime,
        homeRoot: root,
        timerFactory: () => ({ cancel: () => undefined }),
        store: {
          repository,
          locks,
          holder: "test",
          ttl: 900,
          ownershipOf: () => ownership,
          database: connection.database,
        },
      });
      const first = service.start(spec());
      if ("error" in first) throw new Error(first.error);
      await service.status(first.run_id, true);
      // fence 1 installed and then disposed — its own, by fence
      expect(runtime.disposedFences()).toEqual([1]);
      expect(runtime.installedFences()).toEqual([]);
      // a second acquisition of the SAME run installs under its own fence, and
      // stays in flight so it is the CURRENT stretch for the assertion below
      const second = service.start(null, {}, { resumeRunId: first.run_id });
      if ("error" in second) throw new Error(second.error);
      settleSecond = async (): Promise<void> => {
        openSecond();
        await service.status(first.run_id, true);
      };
      expect(runtime.installedFences()).toEqual([2]);
      // stretch 1's wrapper grants nothing now that stretch 2 owns the run —
      // even for a path inside stretch 1's own former working root
      mkdirSync(join(root, "runs", first.run_id, "work-1"), { recursive: true });
      expect(
        runtime.retiredTool(1, "write_file", {
          path: join(root, "runs", first.run_id, "work-1", "x.txt"),
        }),
      ).toBe("ERROR: workflow stretch is no longer current (sandbox denied)");
      // stretch 2's own wrapper still works, in its own root
      mkdirSync(join(root, "runs", first.run_id, "work-2"), { recursive: true });
      expect(
        runtime.leafTool(2, "write_file", {
          path: join(root, "runs", first.run_id, "work-2", "x.txt"),
        }),
      ).toBe("allowed:write_file");
      await settleSecond();
      settleSecond = null;
      expect(runtime.disposedFences()).toEqual([1, 2]);
    } finally {
      try {
        if (settleSecond !== null) await settleSecond();
      } finally {
        try {
          connection.close();
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  });
});
