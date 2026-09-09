import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { AuditRepository } from "../src/state/audit-repository.js";
import { openStateDatabase } from "../src/state/connection.js";

// Arquivo próprio para não fazer crescer tests/workflow-audit-live.test.ts
// (1213 linhas na base, já acima do limite de 800 de `arquivo-grande`;
// issue #93, scripts/ci/contratos/lib.ts:156-160). O AC de #235 pede a
// cobertura em "tests/workflow-audit-live.test.ts, ou o arquivo que você
// criar" — este é o arquivo criado, dentro do glob `tests/state-*.test.ts`
// declarado em Files.

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function database() {
  const root = mkdtempSync(join(tmpdir(), "lohra-state-audit-busy-"));
  roots.push(root);
  const connection = openStateDatabase(join(root, "state.db"), { environment: {} });
  return { connection, audit: new AuditRepository(connection.database) };
}

describe("AuditRepository.isBusyError — código do driver antes do texto", () => {
  it("treats a real SqliteError with code SQLITE_BUSY as busy", () => {
    const { connection, audit } = database();
    try {
      const error = new Database.SqliteError("database is locked", "SQLITE_BUSY");
      expect(audit.isBusyError(error)).toBe(true);
    } finally {
      connection.close();
    }
  });

  it("treats SQLITE_BUSY_SNAPSHOT as busy", () => {
    const { connection, audit } = database();
    try {
      const error = new Database.SqliteError("snapshot is busy", "SQLITE_BUSY_SNAPSHOT");
      expect(audit.isBusyError(error)).toBe(true);
    } finally {
      connection.close();
    }
  });

  it("falls back to the message when the error carries no code", () => {
    const { connection, audit } = database();
    try {
      expect(audit.isBusyError(new Error("database is locked"))).toBe(true);
      expect(audit.isBusyError(new Error("database is busy"))).toBe(true);
    } finally {
      connection.close();
    }
  });

  it("rejects an unrelated code even when the message mentions busy", () => {
    const { connection, audit } = database();
    try {
      const error = Object.assign(new Error("database is busy"), {
        code: "SQLITE_CONSTRAINT",
      });
      expect(audit.isBusyError(error)).toBe(false);
    } finally {
      connection.close();
    }
  });

  it("rejects non-Error values and errors with an unrelated message", () => {
    const { connection, audit } = database();
    try {
      expect(audit.isBusyError("database is busy")).toBe(false);
      expect(audit.isBusyError(new Error("disk I/O error"))).toBe(false);
    } finally {
      connection.close();
    }
  });
});
