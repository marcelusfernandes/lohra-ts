// Issue #477: equivalência da paginação de `AuditRepository.query` antes e
// depois de mover `afterSeq`/`limit` (e os filtros de `matches()` — node_id,
// event_type, sub_id, segment_id, attempt) para o SQL. Este arquivo é um
// ORÁCULO VERDE na base (declarado no corpo do commit `test(red):` — a
// issue #477 item (b) permite isso: "pode ser oráculo verde se a semântica
// for preservada"): o contrato público (`events`, `has_more`,
// `next_after_seq`, `snapshot_seq`, `integrity`) não muda, só como
// `query()` busca as linhas por baixo. Fica em arquivo próprio (não em
// `tests/workflow-audit-live.test.ts`, 1211 linhas, fora dos `Files` da
// issue) e cabe no glob `tests/state-audit-repository*.test.ts` que a issue
// já prevê.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AuditRepository } from "../src/state/audit-repository.js";
import { openStateDatabase } from "../src/state/connection.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function database() {
  const root = mkdtempSync(join(tmpdir(), "lohra-state-audit-repository-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"), { environment: {} });
  return { connection, audit: new AuditRepository(connection.database) };
}

describe("AuditRepository.query — paginação em SQL preserva o envelope (#477)", () => {
  it("250 eventos, páginas sucessivas via afterSeq devolvem os mesmos eventos/has_more/next_after_seq/snapshot_seq", () => {
    const { connection, audit } = database();
    try {
      for (let i = 1; i <= 250; i += 1)
        audit.append("run-250", { event_type: "leaf.started", sub_id: `leaf-${String(i)}` });

      const page1 = audit.query({ runId: "run-250", limit: 100 });
      expect(page1.events.map((event) => event.seq)).toEqual(
        Array.from({ length: 100 }, (_, index) => index + 1),
      );
      expect(page1.page).toMatchObject({
        has_more: true,
        next_after_seq: 100,
        snapshot_seq: 250,
        returned: 100,
      });

      const page2 = audit.query({
        runId: "run-250",
        afterSeq: page1.page.next_after_seq as number,
        limit: 100,
      });
      expect(page2.events.map((event) => event.seq)).toEqual(
        Array.from({ length: 100 }, (_, index) => index + 101),
      );
      expect(page2.page).toMatchObject({
        has_more: true,
        next_after_seq: 200,
        snapshot_seq: 250,
        returned: 100,
      });

      const page3 = audit.query({
        runId: "run-250",
        afterSeq: page2.page.next_after_seq as number,
        limit: 100,
      });
      expect(page3.events.map((event) => event.seq)).toEqual(
        Array.from({ length: 50 }, (_, index) => index + 201),
      );
      expect(page3.page).toMatchObject({
        has_more: false,
        next_after_seq: 250,
        snapshot_seq: 250,
        returned: 50,
      });
    } finally {
      connection.close();
    }
  });

  it("filtra node_id e event_type em SQL sem perder a paginação entre eventos intercalados de outro node/tipo", () => {
    const { connection, audit } = database();
    try {
      // Intercala 3 famílias (node "a"/leaf.started, node "a"/tool.started,
      // node "b"/leaf.started) para provar que o filtro roda na consulta —
      // `matches()` (removido) fazia exatamente esse filtro em JS depois de
      // decodificar tudo; agora as colunas `node_id`/`event_type` fazem o
      // mesmo filtro no SQL, byte a byte equivalente (node_path tem no
      // máximo 1 item por evento, `audit-model.ts:publicAuditIdentity`).
      for (let i = 1; i <= 30; i += 1) {
        audit.append("run-mix", {
          event_type: "leaf.started",
          node_id: "a",
          sub_id: `a-${String(i)}`,
        });
        audit.append("run-mix", {
          event_type: "tool.started",
          node_id: "a",
          sub_id: `a-${String(i)}`,
        });
        audit.append("run-mix", {
          event_type: "leaf.started",
          node_id: "b",
          sub_id: `b-${String(i)}`,
        });
      }
      const page = audit.query({
        runId: "run-mix",
        nodeId: "a",
        eventType: "leaf.started",
        limit: 10,
      });
      expect(page.events).toHaveLength(10);
      for (const event of page.events) {
        expect(event.event_type).toBe("leaf.started");
        expect(event.identity.node_path).toEqual(["a"]);
      }
      expect(page.page.has_more).toBe(true);

      const next = audit.query({
        runId: "run-mix",
        nodeId: "a",
        eventType: "leaf.started",
        afterSeq: page.page.next_after_seq as number,
        limit: 100,
      });
      expect(next.events).toHaveLength(20);
      expect(next.page.has_more).toBe(false);
    } finally {
      connection.close();
    }
  });

  it("snapshotSeq trava a janela no run inteiro mesmo com eventos gravados depois da chamada", () => {
    const { connection, audit } = database();
    try {
      for (let i = 1; i <= 200; i += 1)
        audit.append("run-snap", { event_type: "leaf.started", sub_id: `leaf-${String(i)}` });

      const first = audit.query({ runId: "run-snap", limit: 50, snapshotSeq: 150 });
      expect(first.page.snapshot_seq).toBe(150);
      expect(first.events[0]?.seq).toBe(1);

      const last = audit.query({
        runId: "run-snap",
        afterSeq: 100,
        limit: 100,
        snapshotSeq: 150,
      });
      expect(last.events.map((event) => event.seq)).toEqual(
        Array.from({ length: 50 }, (_, index) => index + 101),
      );
      expect(last.page.has_more).toBe(false);
      expect(last.page.next_after_seq).toBe(150);
    } finally {
      connection.close();
    }
  });

  it("filtra por segment_id e attempt em SQL — mesmas colunas gravadas em append()", () => {
    const { connection, audit } = database();
    try {
      audit.append("run-seg", {
        event_type: "tool.started",
        segment_id: "seg-1",
        attempt: 1,
        sub_id: "x",
      });
      audit.append("run-seg", {
        event_type: "tool.started",
        segment_id: "seg-2",
        attempt: 1,
        sub_id: "x",
      });
      audit.append("run-seg", {
        event_type: "tool.started",
        segment_id: "seg-1",
        attempt: 2,
        sub_id: "x",
      });

      const bySegment = audit.query({ runId: "run-seg", segmentId: "seg-1" });
      expect(bySegment.events).toHaveLength(2);

      const byAttempt = audit.query({ runId: "run-seg", segmentId: "seg-1", attempt: 2 });
      expect(byAttempt.events).toHaveLength(1);
      expect(byAttempt.events[0]?.identity.attempt).toBe(2);
    } finally {
      connection.close();
    }
  });
});

describe("AuditRepository.query — custo por página, não por run (#498)", () => {
  it("decodifica no máximo limit+1 linhas mais os marcadores, nunca o run inteiro", () => {
    const { connection, audit } = database();
    try {
      const total = 300;
      for (let i = 1; i <= total; i += 1)
        audit.append("run-big", { event_type: "leaf.started", sub_id: `leaf-${String(i)}` });

      const limit = 10;
      const parseSpy = vi.spyOn(JSON, "parse");
      try {
        const page = audit.query({ runId: "run-big", limit });
        expect(page.events).toHaveLength(limit);
        const markers = page.integrity.event_markers as Readonly<Record<string, number>>;
        const markerCount = Object.values(markers).reduce((sum, value) => sum + value, 0);
        // #477 already made the page's own SQL proportional to `limit`; #498
        // closes the remaining gap — before this issue, `snapshotRows`
        // decoded EVERY row up to `snapshot` (all 300 here) to derive
        // run-wide `notices`/`field_markers`/`event_markers`, so a page's
        // decode count grew with the WHOLE run, not just its own window.
        expect(
          parseSpy.mock.calls.length,
          "MUTATION_CAUSE:M498-full-run-decode",
        ).toBeLessThanOrEqual(limit + 1 + markerCount);
      } finally {
        parseSpy.mockRestore();
      }
    } finally {
      connection.close();
    }
  });
});
