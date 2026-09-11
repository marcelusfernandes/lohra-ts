// Issue #390: `parseAuditQuery` (`src/workflow/audit-query.ts`) tratava ""
// nos quatro filtros de string (node_id/event_type/sub_id/segment_id) e
// `attempt: 0` como filtro ATIVO em vez de ausência. Um chamador com schema
// estrito (Codex `strict: true`) preenche o schema inteiro, então esses
// campos opcionais chegam ""/0 em vez de omitidos, e a query resultante
// filtrava por um valor que nunca bate contra o ledger — `events: []`
// silencioso mesmo com o run cheio de eventos (dogfooding da PR #389/#373).
// RED na base 4fbd65df: os testes (i) e (iv) abaixo falham — "" e 0 viram
// filtro ativo; (ii)/(iii) já passam (fronteira pré-existente).
//
// Não existia teste do parser antes desta issue. (iv) monta o handler real
// `workflow_audit` com sqlite real, MESMA montagem de `tests/
// workflow-audit-tool.test.ts` (describe "#373", `harness`/`USAGE`/`spec`) —
// copiada aqui em vez de importada porque esse arquivo (775 linhas) não
// cresce (issue #390's Files não o inclui).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseAuditQuery, type AuditQueryResult } from "../src/workflow/audit-query.js";
import type { AuditQuery } from "../src/state/audit-repository.js";
import {
  AuditRepository,
  LockRepository,
  openStateDatabase,
  WorkflowRepository,
} from "../src/state/index.js";
import { AuditTrail } from "../src/workflow/audit-trail.js";
import { WorkflowService, type OwnershipStore } from "../src/workflow/service.js";
import type { ChildResult, ChildRuntime, LeafSandboxHandle } from "../src/workflow/runtime.js";
import { workflowToolHandlers } from "../src/workflow/tool.js";

function unwrap(result: AuditQueryResult): AuditQuery {
  if ("error" in result) throw new Error(result.error);
  return result.query;
}

describe('parseAuditQuery — filtros opcionais ""/0 são ausência, não filtro (#390)', () => {
  it('node_id/event_type/sub_id/segment_id "" e attempt 0 produzem a MESMA query que omitir os campos', () => {
    const omitted = parseAuditQuery({ run_id: "run-1" });
    const filled = parseAuditQuery({
      run_id: "run-1",
      node_id: "",
      event_type: "",
      sub_id: "",
      segment_id: "",
      attempt: 0,
    });
    expect(filled).toEqual(omitted);
  });

  it('run_id "" continua rejeitado', () => {
    const out = parseAuditQuery({ run_id: "" });
    expect("error" in out).toBe(true);
  });

  it("filtros reais continuam ativos (node_id, attempt)", () => {
    const query = unwrap(parseAuditQuery({ run_id: "run-1", node_id: "n1", attempt: 2 }));
    expect(query.nodeId).toBe("n1");
    expect(query.attempt).toBe(2);
  });
});

// --- montagem sqlite real, copiada de tests/workflow-audit-tool.test.ts
// (describe "workflow audit — same-turn read after run_workflow (#373)")
// sem editar aquele arquivo. ---

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

function spec(): Record<string, unknown> {
  return {
    meta: { name: "audit-query-filtros" },
    nodes: [{ id: "a", type: "agent", prompt: "one" }],
  };
}

function harness(runtime: ChildRuntime): {
  readonly service: WorkflowService;
  readonly audit: AuditRepository;
  readonly close: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "lohra-audit-query-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"));
  const repository = new WorkflowRepository(connection.database);
  const locks = new LockRepository(connection.database);
  const audit = new AuditRepository(connection.database);
  const trail = new AuditTrail(audit);
  const ownership = { fence: 0 as number, holder: "test", now: 1000 };
  const store: OwnershipStore = {
    repository,
    locks,
    holder: "test",
    ttl: 900,
    ownershipOf: () => ownership,
    database: connection.database,
  };
  const service = new WorkflowService({ runtime, auditTrail: trail, store });
  return {
    service,
    audit,
    close: (): void => {
      connection.close();
    },
  };
}

function simpleRuntime(): ChildRuntime {
  return {
    spawn: (): string => "leaf-1",
    collect: (): ChildResult => ({ status: "complete", output: { ok: true }, usage: USAGE }),
    steer: () => undefined,
    cancel: () => undefined,
    installLeafSandbox: (): LeafSandboxHandle => ({ dispose: () => undefined }),
  };
}

describe('workflow_audit (handler real) — opcionais ""/0 devolvem os eventos do run (#390)', () => {
  it('run_workflow → workflow_status(wait) → workflow_audit com node_id/event_type/sub_id/segment_id "" e attempt 0 devolve events não-vazio', async () => {
    const { service, audit, close } = harness(simpleRuntime());
    try {
      const handlers = workflowToolHandlers(service, audit);
      const runOut = await handlers.run_workflow?.({ spec: spec() });
      const runJson = JSON.parse((runOut ?? "").replace(/^ERROR: /, "")) as { run_id: string };
      await handlers.workflow_status?.({ run_id: runJson.run_id, wait: true });
      const auditOut = await handlers.workflow_audit?.({
        run_id: runJson.run_id,
        node_id: "",
        event_type: "",
        sub_id: "",
        segment_id: "",
        attempt: 0,
        limit: 50,
      });
      const parsed = JSON.parse(auditOut ?? "{}") as { events: readonly unknown[] };
      expect(parsed.events.length).toBeGreaterThan(0);
    } finally {
      close();
    }
  });
});
