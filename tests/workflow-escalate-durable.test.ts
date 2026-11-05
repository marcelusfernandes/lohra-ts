// Issue #981 (S4 do épico #976): o `escalate` pelo caminho durável real — um
// `WorkflowService` sobre sqlite, com lease, ledger e `lohra workflow`. O que prende:
//   - o run fica `paused` com o motivo `escalated`; o `workflow_status` ao vivo
//     (`pause_reason`) e o frio (`reason`, de um serviço novo sobre o mesmo banco)
//     trazem a escalation `{node_id, kind, summary}` e o hint;
//   - um resume sem a resposta é recusado por um erro que nomeia o nó, o resumo e a
//     forma da resposta — sem tomar lease, sem spawn, sem evento novo no ledger;
//   - com `checkpoint_answers[node_id]` o run conclui, a saída fica em cache e o que já
//     rodou não roda de novo; um resume depois disso não pergunta de novo;
//   - `when` falso conclui direto, sem pausa;
//   - dentro de um `workflow` aninhado a chave é a escopada (`sub.review`), e a recusa a nomeia;
//   - `lohra workflow list` mostra o motivo e o `kind`; `watch` imprime o hint no stderr.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runWorkflowCommand } from "../src/commands/workflow.js";
import {
  AuditRepository,
  LockRepository,
  openStateDatabase,
  WorkflowRepository,
} from "../src/state/index.js";
import { AuditTrail } from "../src/workflow/audit-trail.js";
import { ESCALATED_HINT, ESCALATED_PAUSE } from "../src/workflow/service-rollup.js";
import { WorkflowService, type OwnershipStore } from "../src/workflow/service.js";
import type {
  ChildResult,
  ChildRuntime,
  ChildSpawnRequest,
  LeafSandboxHandle,
} from "../src/workflow/runtime.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const USAGE = {
  inputTokens: 3,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

/** Every leaf completes at once: a scan answers `{risk: 9}`, anything else a short note. */
function completingRuntime(spawned: ChildSpawnRequest[]): ChildRuntime {
  const prompts = new Map<string, string>();
  return {
    spawn: (request: ChildSpawnRequest): string => {
      spawned.push(request);
      const id = `leaf-${String(spawned.length)}`;
      prompts.set(id, request.prompt);
      return id;
    },
    collect: (id: string): ChildResult => ({
      status: "complete",
      output: (prompts.get(id) ?? "").startsWith("Scan") ? { risk: 9 } : "done",
      usage: USAGE,
    }),
    steer: () => undefined,
    cancel: () => undefined,
    installLeafSandbox: (): LeafSandboxHandle => ({ dispose: () => undefined }),
  };
}

const INNER = {
  meta: { name: "inner" },
  nodes: [
    {
      id: "review",
      type: "escalate",
      when: { field_true: { path: "${args.flag}" } },
      kind: "inner_review",
      summary: "inner case",
    },
  ],
};

function harness() {
  const spawned: ChildSpawnRequest[] = [];
  const root = mkdtempSync(join(tmpdir(), "lohra-escalate-durable-"));
  roots.push(root);
  const databasePath = join(root, "state.db");
  const connection = openStateDatabase(databasePath);
  const repository = new WorkflowRepository(connection.database);
  const locks = new LockRepository(connection.database);
  const audit = new AuditRepository(connection.database);
  const acquire = vi.spyOn(locks, "acquireRunLease");
  const store: OwnershipStore = {
    repository,
    locks,
    holder: "test",
    ttl: 900,
    ownershipOf: () => ({ fence: 0, holder: "test", now: 1000 }),
    database: connection.database,
  };
  const newService = (): WorkflowService =>
    new WorkflowService({
      runtime: completingRuntime(spawned),
      auditTrail: new AuditTrail(audit),
      store,
      loader: () => INNER,
    });
  return {
    spawned,
    databasePath,
    acquire,
    locks,
    audit,
    repository,
    newService,
    close: (): void => {
      connection.close();
    },
  };
}

type Harness = ReturnType<typeof harness>;

const SUMMARY = "Risk 9 on hello";
const PAYLOAD = { node_id: "review", kind: "high_risk", summary: SUMMARY };

const spec = (): Record<string, unknown> => ({
  meta: { name: "escalate-durable" },
  nodes: [
    { id: "scan", type: "agent", prompt: "Scan ${args.text}" },
    {
      id: "review",
      type: "escalate",
      when: { gte: { path: "${scan.risk}", n: 7 } },
      kind: "high_risk",
      summary: "Risk ${scan.risk} on ${args.text}",
    },
    { id: "ship", type: "agent", prompt: "Ship ${args.text}", depends_on: ["review"] },
  ],
});

async function launch(
  h: Harness,
  raw: unknown = spec(),
  args: Record<string, unknown> = { text: "hello" },
) {
  const service = h.newService();
  const started = service.start(raw, args);
  if ("error" in started) throw new Error(started.error);
  const live = (await service.status(started.run_id, true)) as Record<string, unknown>;
  return { service, runId: started.run_id, live };
}

const cold = async (h: Harness, runId: string): Promise<Record<string, unknown>> =>
  (await h.newService().status(runId, true)) as Record<string, unknown>;

describe("a durable escalation pauses the run and says so (#981)", () => {
  it("the live view carries the reason, the escalation and the hint", async () => {
    const h = harness();
    try {
      const { live } = await launch(h);
      expect(live.status).toBe("paused");
      expect(live.pause_reason).toBe(ESCALATED_PAUSE);
      expect(live.pause_reason).toBe("escalated");
      expect(live.escalation).toEqual(PAYLOAD);
      expect(live.hint).toBe(ESCALATED_HINT);
      expect(h.spawned).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("a cold read from another service carries the same three, and no checkpoint", async () => {
    const h = harness();
    try {
      const { runId } = await launch(h);
      const view = await cold(h, runId);
      expect(view.status).toBe("paused");
      expect(view.reason).toBe("escalated");
      expect(view.escalation).toEqual(PAYLOAD);
      expect(view.hint).toBe(ESCALATED_HINT);
      expect(view.resume_at).toBeNull();
      expect(view).not.toHaveProperty("checkpoint");
    } finally {
      h.close();
    }
  });

  it("the hint says how to answer, that the id is scoped when nested, and that nothing resumes it", () => {
    expect(ESCALATED_HINT).toContain("checkpoint_answers");
    expect(ESCALATED_HINT).toContain("<node_id>");
    expect(ESCALATED_HINT).toContain("sub.review");
    expect(ESCALATED_HINT).toMatch(/nothing (will )?resume/u);
    expect(ESCALATED_HINT).toContain("rename_hint");
  });
});

describe("a summary that cannot render still stops the run for a person (#981, round 2)", () => {
  const TEMPLATE = "Risk ${scan.risk}: ${scan.reason}";
  const broken = (): Record<string, unknown> => {
    const raw = spec();
    const nodes = raw.nodes as Record<string, unknown>[];
    return {
      ...raw,
      nodes: nodes.map((n) => (n.id === "review" ? { ...n, summary: TEMPLATE } : n)),
    };
  };

  it("pauses as escalated with the marked template, names the missing ref, and runs nothing after it", async () => {
    const h = harness();
    try {
      const { runId, live } = await launch(h, broken());
      expect(live.status).toBe("paused");
      expect(live.pause_reason).toBe("escalated");
      expect(live.escalation).toEqual({
        node_id: "review",
        kind: "high_risk",
        summary: `[unrendered] ${TEMPLATE}`,
      });
      expect((live.faults as string[]).join("\n")).toContain("no value for ${scan.reason}");
      expect(h.spawned.map((request) => request.prompt)).toEqual(["Scan hello"]);

      const view = await cold(h, runId);
      expect(view.reason).toBe("escalated");
      expect(view.escalation).toMatchObject({ summary: `[unrendered] ${TEMPLATE}` });
    } finally {
      h.close();
    }
  });

  it("a resume without the answer is refused with the marked summary; the answer lets the run finish", async () => {
    const h = harness();
    try {
      const { runId } = await launch(h, broken());
      const refused = h.newService().start(null, {}, { resumeRunId: runId });
      expect("error" in refused).toBe(true);
      if (!("error" in refused)) throw new Error("expected a refusal");
      expect(refused.error).toContain(`[unrendered] ${TEMPLATE}`);

      const service = h.newService();
      const resumed = service.start(
        null,
        {},
        { resumeRunId: runId, checkpointAnswers: { review: "go" } },
      );
      if ("error" in resumed) throw new Error(resumed.error);
      const final = (await service.status(runId, true)) as Record<string, unknown>;
      expect(final.status).toBe("complete");
      expect((final.outputs as Record<string, unknown>).review).toEqual({
        escalated: true,
        kind: "high_risk",
        summary: `[unrendered] ${TEMPLATE}`,
        answer: "go",
      });
      expect(h.spawned.map((request) => request.prompt)).toEqual(["Scan hello", "Ship hello"]);
    } finally {
      h.close();
    }
  });
});

describe("a resume without the answer is refused before it takes anything (#981)", () => {
  it("names the node, the summary and the answer to send; the run stays as it was", async () => {
    const h = harness();
    try {
      const { runId } = await launch(h);
      const acquired = h.acquire.mock.calls.length;
      const events = h.audit.query({ runId, limit: 500 }).events.length;

      const resumed = h.newService().start(null, {}, { resumeRunId: runId });
      expect("error" in resumed).toBe(true);
      if (!("error" in resumed)) throw new Error("expected a refusal");
      expect(resumed.error).toContain("waiting for an answer");
      expect(resumed.error).toContain("is paused at escalation 'review'");
      expect(resumed.error).toContain(SUMMARY);
      expect(resumed.error).toContain('checkpoint_answers: {"review"');

      expect(h.acquire.mock.calls).toHaveLength(acquired);
      expect(h.locks.runLeaseExpiry(runId, 1000)).toBeNull();
      expect(h.audit.query({ runId, limit: 500 }).events).toHaveLength(events);
      expect(h.spawned).toHaveLength(1);
      const still = await cold(h, runId);
      expect(still.status).toBe("paused");
      expect(still.reason).toBe("escalated");
      expect(still.attempts).toBe(1);
    } finally {
      h.close();
    }
  });

  it("a checkpoint pause is still refused in the same words, with its prompt", async () => {
    const h = harness();
    try {
      const raw = {
        meta: { name: "checkpoint-refusal" },
        nodes: [{ id: "cp", type: "checkpoint", prompt: "go on?" }],
      };
      const { runId } = await launch(h, raw, {});
      const resumed = h.newService().start(null, {}, { resumeRunId: runId });
      expect("error" in resumed).toBe(true);
      if (!("error" in resumed)) throw new Error("expected a refusal");
      expect(resumed.error).toContain("is paused at checkpoint 'cp'");
      expect(resumed.error).toContain("waiting for an answer: go on?");
      expect(resumed.error).toContain('checkpoint_answers: {"cp"');
    } finally {
      h.close();
    }
  });

  it("an answer under another key is not the answer", async () => {
    const h = harness();
    try {
      const { runId } = await launch(h);
      const resumed = h
        .newService()
        .start(null, {}, { resumeRunId: runId, checkpointAnswers: { elsewhere: "yes" } });
      expect("error" in resumed).toBe(true);
      expect((await cold(h, runId)).status).toBe("paused");
    } finally {
      h.close();
    }
  });
});

describe("an answer completes the run, once (#981)", () => {
  it("resumes with checkpoint_answers[node_id]: the output is the answer, and only what is left runs", async () => {
    const h = harness();
    try {
      const { runId } = await launch(h);
      const service = h.newService();
      const resumed = service.start(
        null,
        {},
        { resumeRunId: runId, checkpointAnswers: { review: "approved" } },
      );
      if ("error" in resumed) throw new Error(resumed.error);
      expect(((await service.status(runId, true)) as Record<string, unknown>).status).toBe(
        "complete",
      );
      expect((await cold(h, runId)).status).toBe("complete");
      expect(h.spawned.map((request) => request.prompt)).toEqual(["Scan hello", "Ship hello"]);
    } finally {
      h.close();
    }
  });

  it("keeps the answer in the outputs and never asks again on a later resume", async () => {
    const h = harness();
    try {
      const { runId } = await launch(h);
      const service = h.newService();
      const resumed = service.start(
        null,
        {},
        { resumeRunId: runId, checkpointAnswers: { review: "approved" } },
      );
      if ("error" in resumed) throw new Error(resumed.error);
      const final = (await service.status(runId, true)) as Record<string, unknown>;
      expect(final.status).toBe("complete");
      const outputs = final.outputs as Record<string, unknown>;
      expect(outputs.review).toEqual({
        escalated: true,
        kind: "high_risk",
        summary: SUMMARY,
        answer: "approved",
      });

      // A third stretch, with no answer at all: the stored cell answers, nothing pauses or spawns.
      const later = h.newService();
      const again = later.start(null, {}, { resumeRunId: runId });
      if ("error" in again) throw new Error(again.error);
      const replayed = (await later.status(runId, true)) as Record<string, unknown>;
      expect(replayed.status).toBe("complete");
      expect((replayed.outputs as Record<string, unknown>).review).toEqual(outputs.review);
      expect(h.spawned).toHaveLength(2);
    } finally {
      h.close();
    }
  });
});

describe("a false when does not stop a durable run (#981)", () => {
  it("completes straight through with {escalated:false} and no pause", async () => {
    const h = harness();
    try {
      const calm = {
        meta: { name: "escalate-calm" },
        nodes: [
          { id: "scan", type: "agent", prompt: "Scan ${args.text}" },
          {
            id: "review",
            type: "escalate",
            when: { gte: { path: "${scan.risk}", n: 10 } },
            kind: "high_risk",
            summary: "never shown",
          },
        ],
      };
      const second = await launch(h, calm);
      expect(second.live.status).toBe("complete");
      expect((second.live.outputs as Record<string, unknown>).review).toEqual({ escalated: false });
      expect(second.live).not.toHaveProperty("escalation");
    } finally {
      h.close();
    }
  });
});

describe("inside a nested workflow the durable key is the scoped one (#981)", () => {
  const nested = (): Record<string, unknown> => ({
    meta: { name: "outer" },
    nodes: [{ id: "sub", type: "workflow", ref: "inner", args: { flag: true } }],
  });

  it("pauses with node_id sub.review, refuses a resume that does not name it, and takes it scoped", async () => {
    const h = harness();
    try {
      const { runId, live } = await launch(h, nested(), {});
      expect(live.status).toBe("paused");
      expect(live.escalation).toEqual({
        node_id: "sub.review",
        kind: "inner_review",
        summary: "inner case",
      });

      const refused = h.newService().start(null, {}, { resumeRunId: runId });
      expect("error" in refused).toBe(true);
      if (!("error" in refused)) throw new Error("expected a refusal");
      expect(refused.error).toContain("sub.review");

      const service = h.newService();
      const resumed = service.start(
        null,
        {},
        { resumeRunId: runId, checkpointAnswers: { "sub.review": "ok" } },
      );
      if ("error" in resumed) throw new Error(resumed.error);
      const final = (await service.status(runId, true)) as Record<string, unknown>;
      expect(final.status).toBe("complete");
      expect((final.outputs as Record<string, unknown>).sub).toEqual({
        review: { escalated: true, kind: "inner_review", summary: "inner case", answer: "ok" },
      });
    } finally {
      h.close();
    }
  });
});

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function command(
  h: Harness,
  action: "list" | "watch",
  args: Record<string, unknown>,
): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const code = await runWorkflowCommand({
    action,
    databasePath: h.databasePath,
    args,
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr += value;
    },
    sleep: () => Promise.resolve(),
    now: () => 1000,
  });
  return { code, stdout, stderr };
}

describe("lohra workflow shows the escalation (#981)", () => {
  it("list prints the reason and the kind of a run paused for review", async () => {
    const h = harness();
    try {
      await launch(h);
      const listed = await command(h, "list", {});
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain("paused (escalated: high_risk)");
    } finally {
      h.close();
    }
  });

  it("list keeps the plain suffix for a checkpoint pause", async () => {
    const h = harness();
    try {
      const raw = {
        meta: { name: "checkpoint-list" },
        nodes: [{ id: "cp", type: "checkpoint", prompt: "go?" }],
      };
      await launch(h, raw, {});
      const listed = await command(h, "list", {});
      expect(listed.stdout).toContain("paused (checkpoint)");
      expect(listed.stdout).not.toContain("escalated");
    } finally {
      h.close();
    }
  });

  it("watch prints the escalation hint on stderr when it ends paused for review", async () => {
    const h = harness();
    try {
      const { runId } = await launch(h);
      const watched = await command(h, "watch", { run_id: runId });
      expect(watched.code).toBe(0);
      expect(watched.stdout).toContain("(escalated: high_risk)");
      expect(watched.stderr).toBe(`${ESCALATED_HINT}\n`);
    } finally {
      h.close();
    }
  });
});
