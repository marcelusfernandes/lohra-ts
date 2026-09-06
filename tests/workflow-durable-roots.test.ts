import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openStateDatabase, WorkflowRepository, LockRepository } from "../src/state/index.js";
import {
  productionHolder,
  productionOwnershipStore,
  RUN_LEASE_TTL,
} from "../src/workflow/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmpDatabase() {
  const root = mkdtempSync(join(tmpdir(), "lohra-t101-roots-"));
  roots.push(root);
  return openStateDatabase(join(root, "state.db"));
}

describe("productionHolder (AC: holder distinct per call, stable format)", () => {
  it("produces a distinct holder on each call", () => {
    const a = productionHolder();
    const b = productionHolder();
    expect(a).not.toBe(b);
  });

  it("has the stable shape <hostname>:<pid>:<8 hex chars>", () => {
    const holder = productionHolder();
    const parts = holder.split(":");
    expect(parts).toHaveLength(3);
    expect(parts[0]?.length).toBeGreaterThan(0);
    expect(parts[1]).toBe(String(process.pid));
    expect(parts[2]).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("productionOwnershipStore (AC: built over the caller's own connection, ttl = RUN_LEASE_TTL)", () => {
  it("never opens a second connection — repository/locks/database share the one it was given", () => {
    const connection = tmpDatabase();
    try {
      const store = productionOwnershipStore(connection.database);
      expect(store.database).toBe(connection.database);
      expect(store.ttl).toBe(RUN_LEASE_TTL);
      expect(store.repository).toBeInstanceOf(WorkflowRepository);
      expect(store.locks).toBeInstanceOf(LockRepository);
    } finally {
      connection.close();
    }
  });

  it("defaults to a fresh productionHolder, reused across ownershipOf() calls", () => {
    const connection = tmpDatabase();
    try {
      const store = productionOwnershipStore(connection.database);
      expect(store.ownershipOf().holder).toBe(store.holder);
      expect(store.ownershipOf().holder).toBe(store.holder); // stable across calls
    } finally {
      connection.close();
    }
  });

  it("accepts an injected clock for ownershipOf().now", () => {
    const connection = tmpDatabase();
    try {
      const store = productionOwnershipStore(connection.database, { now: () => 1234 });
      expect(store.ownershipOf().now).toBe(1234);
    } finally {
      connection.close();
    }
  });
});
