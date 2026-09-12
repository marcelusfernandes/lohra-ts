// Issue #481 (achado do QA pós-merge c959e68f, PR #480): todo teste
// existente cria o banco com `openStateDatabase` do próprio HEAD, que já
// aplica `addedColumns` (`src/state/schema.ts`) via `addMissingColumns`
// (`src/state/connection.ts:68-76`) antes de qualquer asserção — nenhum
// abre um arquivo SQLite pré-existente sem a coluna. A prova manual do QA
// (schema de ec3a4065 → aberto pelo HEAD → coluna presente) não é durável.
//
// Esta suíte fecha essa lacuna de duas formas:
//
// 1. Positivos (oráculos, um `it` por entrada REAL de `addedColumns` —
//    gerado por `for...of` sobre a lista importada, não um símbolo novo):
//    `applicationSchema` (a DDL crua) já embute ALGUMAS das colunas de
//    `addedColumns` diretamente na definição da tabela (ex.:
//    `workflow_run_state.progress_json`/`audit_segment_id`,
//    `workflow_node_cost`/`workflow_run_spend`.*_tokens,
//    `workflow_audit_events.attempt`) — a entrada em `addedColumns`
//    sobrevive só para migrar um banco criado ANTES da DDL absorver a
//    coluna; outras (`sessions.priced_call_count`,
//    `workflow_node_cache.identity_version`) nunca entraram na DDL e
//    dependem só do `ALTER TABLE`. `databaseWithoutColumn` cobre as duas
//    situações com o mesmo código: cria o banco com `applicationSchema`
//    completo e, se a coluna sob teste já existir ali, a remove com
//    `ALTER TABLE ... DROP COLUMN` (suportado pelo SQLite empacotado no
//    `better-sqlite3`, 3.49.2) — reproduzindo fielmente "um banco antigo,
//    criado antes da coluna existir" para QUALQUER entrada, sem tocar nas
//    outras colunas da tabela nem nas outras entradas de `addedColumns`.
//    Esperado que passem já na base: a migração aditiva já funciona hoje,
//    o que faltava era a prova.
//
// 2. Negativo: um erro de `ALTER TABLE` que não é "duplicate column name"
//    tem que propagar (fail-closed), não ser engolido. Não dá para
//    forçar isso via lock/concorrência: tanto `CREATE TABLE IF NOT EXISTS`
//    (schema completo, roda antes) quanto o `ALTER TABLE` de
//    `addMissingColumns` pedem a mesma classe de lock de escrita — um
//    lock que já bloqueia o `CREATE TABLE IF NOT EXISTS` nunca deixa a
//    execução chegar em `addMissingColumns`. Em vez disso, o teste
//    substitui a tabela por uma VIEW de mesmo nome antes de abrir o banco:
//    `CREATE TABLE IF NOT EXISTS` não reclama de um nome já ocupado por
//    outro tipo de objeto (silenciosamente não cria nada), mas o `ALTER
//    TABLE ... ADD COLUMN` seguinte, dentro do laço de
//    `addMissingColumns`, falha com "Cannot add a column to a view" — bem
//    distinto do regex `/duplicate column name/i` que `connection.ts`
//    engole. A tabela escolhida (`workflow_node_cost`) não tem nenhum
//    índice em `applicationSchema`, para que o `CREATE TABLE IF NOT
//    EXISTS` do restante do schema nunca esbarre em "views may not be
//    indexed" antes de chegar no `ALTER TABLE` que este teste quer
//    observar.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openStateDatabase } from "../src/state/index.js";
import { addedColumns, applicationSchema } from "../src/state/schema.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function temporaryPath(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return join(root, "state.db");
}

interface TableInfoRow {
  readonly name: string;
  readonly type: string;
}

/** Banco criado com a DDL completa e, se a coluna sob teste já vier
 * embutida ali, removida com `ALTER TABLE ... DROP COLUMN` — reproduz um
 * banco criado ANTES daquela coluna existir, seja ela histórica na DDL ou
 * dependente só de `addMissingColumns`. */
function databaseWithoutColumn(path: string, table: string, column: string): void {
  const seed = new Database(path);
  try {
    seed.exec(applicationSchema);
    const columns = seed.pragma(`table_info(${table})`) as readonly TableInfoRow[];
    if (columns.some((row) => row.name === column)) {
      seed.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
  } finally {
    seed.close();
  }
}

/** O tipo declarado que `PRAGMA table_info` devolve é só o primeiro
 * token da declaração (`"INTEGER DEFAULT 0"` → `"INTEGER"`) — o resto é
 * `dflt_value`, uma coluna própria do pragma, não parte de `type`. */
function leadingType(declaration: string): string {
  return declaration.split(" ")[0] as string;
}

describe("addedColumns — migração real contra um banco criado sem a coluna (#481)", () => {
  for (const [table, column, declaration] of addedColumns) {
    it(`${table}.${column} (${declaration}) aparece depois de openStateDatabase, num banco que nunca a teve`, () => {
      const path = temporaryPath("lohra-migracoes-aditivas-");
      databaseWithoutColumn(path, table, column);

      const before = new Database(path);
      try {
        const columnsBefore = before.pragma(`table_info(${table})`) as readonly TableInfoRow[];
        expect(columnsBefore.some((row) => row.name === column)).toBe(false);
      } finally {
        before.close();
      }

      const connection = openStateDatabase(path);
      try {
        const columnsAfter = connection.database.pragma(
          `table_info(${table})`,
        ) as readonly TableInfoRow[];
        const migrated = columnsAfter.find((row) => row.name === column);
        expect(migrated).toBeDefined();
        expect(migrated?.type).toBe(leadingType(declaration));
      } finally {
        connection.close();
      }
    });
  }
});

describe("addMissingColumns — erro que não é duplicate column name propaga (#481)", () => {
  it("um ALTER TABLE que falha por outro motivo (tabela virou view) NÃO é engolido", () => {
    const path = temporaryPath("lohra-migracoes-aditivas-negativo-");
    // `workflow_node_cost` não tem índice em `applicationSchema` — o
    // `CREATE TABLE IF NOT EXISTS` do resto do schema nunca esbarra em
    // "views may not be indexed" antes de chegar no `ALTER TABLE` que
    // este teste observa.
    expect(applicationSchema).not.toMatch(/INDEX\b[^;]*\bworkflow_node_cost\b/);
    const alteredTable = "workflow_node_cost";
    expect(addedColumns.some(([table]) => table === alteredTable)).toBe(true);

    const seed = new Database(path);
    try {
      seed.exec(`CREATE VIEW ${alteredTable} AS SELECT 1 AS id`);
    } finally {
      seed.close();
    }

    let thrown: unknown;
    try {
      const connection = openStateDatabase(path);
      connection.close();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).not.toMatch(/duplicate column name/i);
    expect(message).toMatch(/view/i);
  });
});
