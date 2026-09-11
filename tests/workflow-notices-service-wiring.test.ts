// Issue #411 (M8-9): dois dos últimos sinks voláteis do mapa M8 —
// `AutoResumeScheduler.logWarning` e `WorkflowLiveEvents.warning` — devem
// passar por `this.warn`, o `onWarning` que `WorkflowService` já recebe
// (em produção, `noticesSink.warn`: `src/commands/chat.ts:364`,
// `src/commands/dashboard.ts:323`).
//
// `WorkflowLiveEvents` já recebia `this.warn` desde `1e2d4bfa5`
// (2026-09-01, bem antes do notices-sink existir) — `service.ts:407-411`
// nunca passou pelo default `() => undefined` de `live-events.ts:22`, então
// o teste (ii) abaixo já era verde na base; fica como fixação de
// comportamento, não como vermelho. O teste (i) é o vermelho real: até
// #411, `new AutoResumeScheduler(..., { timerFactory })` (`service.ts:423-
// 426`) nunca passava `logWarning`, então o aviso de tentativas esgotadas
// caía no `console.warn` default de `durability.ts:128-132`, nunca no
// `onWarning` do serviço.
//
// Nenhum símbolo novo: `WorkflowService`, `WorkflowRepository`,
// `LockRepository`, `openStateDatabase` e `MAX_RESUME_ATTEMPTS` já existem.
// `notices-sink.ts`/`notices-repository.ts` (#410) não são tocados aqui —
// o mapeamento «auto-resume» → `resume_attempts_exhausted` já está pinado
// em `tests/workflow-notices-sink.test.ts`; este arquivo prova só que a
// MENSAGEM chega ao `onWarning` do `WorkflowService`, o boundary que #411
// entrega.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LockRepository, openStateDatabase, WorkflowRepository } from "../src/state/index.js";
import { MAX_RESUME_ATTEMPTS } from "../src/workflow/durability.js";
import { WorkflowService } from "../src/workflow/service.js";
import type { ChildRuntime } from "../src/workflow/runtime.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function inertRuntime(): ChildRuntime {
  return {
    spawn: () => "leaf",
    collect: () => ({ status: "complete", output: "ok", usage: null }),
    steer: () => undefined,
    cancel: () => undefined,
  };
}

describe("WorkflowService wires this.warn into AutoResumeScheduler and WorkflowLiveEvents", () => {
  it("cold-start rearm of a run already at MAX_RESUME_ATTEMPTS warns through onWarning, not console.warn", () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-notices-service-wiring-"));
    roots.push(root);
    const connection = openStateDatabase(join(root, "state.db"));
    try {
      const repository = new WorkflowRepository(connection.database);
      const locks = new LockRepository(connection.database);
      const fence = locks.acquireRunLease("exhausted-run", "p1", 1000, 60);
      if (fence === null) throw new Error("expected lease");
      repository.putRunState("exhausted-run", {
        name: "exhausted",
        owner: "p1",
        status: "paused",
        pauseReason: "quota_exhausted",
        pausePayloadJson: JSON.stringify({ attempts: MAX_RESUME_ATTEMPTS }),
        specJson: null,
        argsJson: "{}",
        tokenBudget: null,
        tainted: false,
        progressJson: null,
        auditSegmentId: null,
        updatedAt: 1000,
        fence,
        holder: "p1",
        now: 1000,
      });
      const warnings: string[] = [];
      new WorkflowService({
        runtime: inertRuntime(),
        store: {
          repository,
          locks,
          holder: "p1",
          ttl: 900,
          ownershipOf: () => ({ fence: 0, holder: "p1", now: 1000 }),
          database: connection.database,
        },
        onWarning: (message) => warnings.push(message),
      });
      expect(warnings.some((message) => message.includes("auto-resume"))).toBe(true);
      expect(warnings.some((message) => message.includes("exhausted-run"))).toBe(true);
    } finally {
      connection.close();
    }
  });

  it("a live observer that throws warns through onWarning (fixes the wiring live-events.ts:407-411 already had)", async () => {
    const warnings: string[] = [];
    const service = new WorkflowService({
      runtime: inertRuntime(),
      idSource: () => "run-throws",
      onLiveEvent: () => {
        throw new Error("observer boom");
      },
      onWarning: (message) => warnings.push(message),
    });
    expect(
      service.start({
        meta: { name: "throws" },
        nodes: [{ id: "leaf", type: "agent", prompt: "x" }],
      }),
    ).toEqual({ run_id: "run-throws", status: "started" });
    expect(await service.status("run-throws", true)).toMatchObject({ status: "complete" });
    expect(
      warnings.some((message) => message.includes("live observer failed: observer boom")),
    ).toBe(true);
  });
});
