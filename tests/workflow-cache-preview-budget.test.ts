// Issue #540 (achado 6 do veredito de M18): a hipótese era que um `parallel`
// que fosse o primeiro a tentar spawn sob um budget já exaurido classificaria
// `upstream_missing` em vez de `token_budget_exhausted` — `gateTokens`
// (engine.ts) grava um fault SEM prefixo de nó, e `classifyNode`'s fallback
// genérico de `parallel` (`!hasNodeFault`) o confundiria com o caminho
// silencioso de `branches` nunca resolvida a array.
//
// NÃO reproduz (comentário na issue #540, 2026-09-12): `runParallel` chama
// `gateFanout(resolved.length)` ANTES de qualquer branch. Quando o budget
// está exaurido, `tokensRemaining` satura em 0
// (`Math.max(0, tokenBudget - tokensSpent)`), então `affordableLeaves` é
// sempre 0 e QUALQUER largura >= 1 já lança ALI — com fault PREFIXADO
// (`${currentNode}: fan-out of N exceeds affordable leaves 0 — token budget
// exhausted`) — antes de qualquer branch chegar ao `gateTokens()` por-leaf
// (o único caminho que grava um fault sem prefixo). O teste abaixo é uma
// contra-asserção: verde por construção tanto na base quanto depois desta
// PR (nenhum código de produção mudou por causa deste achado) — prende a
// classificação correta que já existe hoje.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AuditRepository,
  LockRepository,
  openStateDatabase,
  WorkflowRepository,
} from "../src/state/index.js";
import { AuditTrail } from "../src/workflow/audit-trail.js";
import { WorkflowService, type OwnershipStore } from "../src/workflow/service.js";
import type { ChildResult, ChildRuntime, LeafSandboxHandle } from "../src/workflow/runtime.js";
import type { PreviewDeps, PreviewNodeOutcome } from "../src/workflow/cache-preview.js";

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

function withSandbox<T extends ChildRuntime>(runtime: T): T {
  return Object.assign(runtime, {
    installLeafSandbox: (): LeafSandboxHandle => ({ dispose: () => undefined }),
  });
}

/** Every leaf completes immediately, deterministic output — same shape as
 * `tests/workflow-cache-preview.test.ts`'s `completingRuntime`, duplicated
 * here (own harness, own file per the issue's `Files` glob). */
function completingRuntime(): ChildRuntime {
  let seq = 0;
  return withSandbox({
    spawn: (): string => {
      seq += 1;
      return `leaf-${String(seq)}`;
    },
    collect: (): ChildResult => ({ status: "complete", output: { ok: true }, usage: USAGE }),
    steer: () => undefined,
    cancel: () => undefined,
  });
}

function harness(options: { readonly runtime?: ChildRuntime } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lohra-cache-preview-budget-"));
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
  const service = new WorkflowService({
    runtime: options.runtime ?? completingRuntime(),
    auditTrail: trail,
    store,
  });
  return {
    service,
    repository,
    database: connection.database,
    preview: async (deps: Omit<PreviewDeps, "database" | "repository" | "locks">) => {
      const { previewResume } = await import("../src/workflow/cache-preview.js");
      return previewResume({ database: connection.database, repository, locks, ...deps });
    },
    close: (): void => {
      connection.close();
    },
  };
}

function nodeOf(
  nodes: readonly PreviewNodeOutcome[],
  nodeId: string,
): PreviewNodeOutcome | undefined {
  return nodes.find((entry) => entry.node_id === nodeId);
}

describe("previewResume — a parallel node behind an exhausted budget reports token_budget_exhausted, not upstream_missing (#540)", () => {
  it("a parallel node after a real-spend agent, tiny budget", async () => {
    const { service, preview, close } = harness();
    try {
      const spec = {
        meta: { name: "preview-budget-parallel" },
        nodes: [
          { id: "a", type: "agent", prompt: "one" },
          { id: "p", type: "parallel", branches: ["x", "y"] },
        ],
      };
      const started = service.start(spec, {}, { tokenBudget: 1 });
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);

      const result = await preview({ tiers: {}, runId: started.run_id, now: 1000 });
      if ("error" in result) throw new Error(result.error);
      expect(nodeOf(result.nodes, "a")?.outcome).toBe("replay");
      expect(nodeOf(result.nodes, "p")?.outcome).toBe("token_budget_exhausted");
    } finally {
      close();
    }
  });
});

// #540 AC: um `it` explícito de precedência — `upstream_missing` (a própria
// falta de valor a montante de um nó) nunca é mascarado por um
// `pauseReason` GLOBAL de `token_budget_exhausted` que só aconteceu depois,
// num nó diferente. `classifyNode` já faz isso hoje (o disjuntor explícito
// de `upstream null`/o fallback silencioso de `parallel` são checados ANTES
// do `pauseReason`) — os dois `it`s abaixo são contra-asserções que
// travam esse comportamento.
describe("previewResume — upstream_missing tem precedência sobre um pauseReason global de token_budget_exhausted (#540)", () => {
  it("um parallel cujas branches nunca resolveram (silencioso) fica upstream_missing mesmo com um budget exaurido depois, por outro nó", async () => {
    const { service, preview, close } = harness();
    try {
      const spec = {
        meta: { name: "preview-precedence-parallel" },
        nodes: [
          { id: "p", type: "parallel", branches: "${args.missing}" },
          { id: "spend1", type: "agent", prompt: "one" },
          { id: "spend2", type: "agent", prompt: "two" },
        ],
      };
      const started = service.start(spec, {}, { tokenBudget: 1 });
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);

      const result = await preview({ tiers: {}, runId: started.run_id, now: 1000 });
      if ("error" in result) throw new Error(result.error);
      // spend2 é quem exaure o budget globalmente (mesmo mecanismo do teste
      // já existente em tests/workflow-cache-preview.test.ts) — confirma que
      // o cenário realmente produz um pauseReason de token_budget_exhausted.
      expect(nodeOf(result.nodes, "spend2")?.outcome).toBe("token_budget_exhausted");
      expect(nodeOf(result.nodes, "p")?.outcome).toBe("upstream_missing");
    } finally {
      close();
    }
  });

  it("um agent com upstream null explícito fica upstream_missing mesmo com um budget exaurido depois, por outro nó", async () => {
    const { service, preview, close } = harness();
    try {
      const spec = {
        meta: { name: "preview-precedence-agent" },
        nodes: [
          { id: "upstream", type: "agent", prompt: "${args.missing}" },
          { id: "downstream", type: "agent", prompt: "use ${upstream.out}" },
          { id: "spend1", type: "agent", prompt: "one" },
          { id: "spend2", type: "agent", prompt: "two" },
        ],
      };
      const started = service.start(spec, {}, { tokenBudget: 1 });
      if ("error" in started) throw new Error(started.error);
      await service.status(started.run_id, true);

      const result = await preview({ tiers: {}, runId: started.run_id, now: 1000 });
      if ("error" in result) throw new Error(result.error);
      expect(nodeOf(result.nodes, "spend2")?.outcome).toBe("token_budget_exhausted");
      expect(nodeOf(result.nodes, "downstream")?.outcome).toBe("upstream_missing");
    } finally {
      close();
    }
  });
});
