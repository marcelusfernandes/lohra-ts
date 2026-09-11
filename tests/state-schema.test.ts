import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StateError } from "../src/state/errors.js";
import { openStateDatabase, stateDatabasePath } from "../src/state/index.js";

const roots: string[] = [];

function temporaryPath(name = "state.db"): string {
  const root = mkdtempSync(join(tmpdir(), "lohra-state-schema-"));
  roots.push(root);
  return join(root, name);
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe("state schema and connection", () => {
  it("creates the contractual schema, metadata, indices, trigger, and pragmas", () => {
    const connection = openStateDatabase(temporaryPath());
    const { database } = connection;
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .pluck()
      .all() as string[];
    const indices = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .pluck()
      .all() as string[];
    const triggers = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .pluck()
      .all() as string[];

    expect(tables).toHaveLength(23);
    expect(indices).toHaveLength(21);
    expect(indices.filter((name) => !name.startsWith("sqlite_autoindex_"))).toEqual([
      "idx_messages_session",
      "idx_sessions_parent",
      "idx_sessions_started",
      "idx_was_updated",
      "idx_wnc_content",
      "idx_wnc_run",
      "idx_wrs_updated",
    ]);
    expect(triggers).toEqual(["messages_fts_ai"]);

    const meta = database
      .prepare("SELECT key, value, typeof(value) AS value_type FROM state_meta")
      .get();
    expect(meta).toEqual({ key: "schema_version", value: "1", value_type: "text" });
    expect(database.pragma("user_version", { simple: true })).toBe(0n);
    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.pragma("page_size", { simple: true })).toBe(4096n);
    expect(database.pragma("encoding", { simple: true })).toBe("UTF-8");
    expect(database.pragma("quick_check", { simple: true })).toBe("ok");

    expect(() =>
      database
        .prepare("INSERT INTO sessions (id,source,parent_session_id,started_at) VALUES (?,?,?,?)")
        .run("fk-child", "cli", "missing-parent", 1),
    ).not.toThrow();

    const sessionInfo = database.pragma("table_info(sessions)") as Record<string, unknown>[];
    expect(sessionInfo.find((column) => column.name === "priced_call_count")).toMatchObject({
      type: "INTEGER",
      notnull: 0n,
      dflt_value: null,
    });
    connection.close();
  });

  it("is idempotent and preserves the historical ALTER shape", () => {
    const path = temporaryPath();
    openStateDatabase(path).close();
    const reopened = openStateDatabase(path);
    const sql = reopened.database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
      .pluck()
      .get() as string;
    expect(sql).toContain("archived INTEGER NOT NULL DEFAULT 0, priced_call_count INTEGER");
    reopened.close();
  });

  it("exercises the explicit DELETE fallback and FTS-absent capability seams", () => {
    const calls: string[] = [];
    const connection = openStateDatabase(temporaryPath(), {
      ftsAvailable: false,
      journalMode: (_database, mode) => {
        calls.push(mode);
        return "delete";
      },
    });
    expect(calls).toEqual(["WAL", "DELETE"]);
    expect(connection.journalFallback).toBe(true);
    expect(connection.journalMode).toBe("delete");
    expect(connection.ftsEnabled).toBe(false);
    expect(
      connection.database
        .prepare("SELECT name FROM sqlite_master WHERE name = 'messages_fts'")
        .get(),
    ).toBeUndefined();
    connection.close();
  });

  it("resolves default, home override, and isolated profile database paths", () => {
    expect(stateDatabasePath({ HOME: "/tmp/u" })).toBe("/tmp/u/.lohra/state.db");
    expect(stateDatabasePath({ HOME: "/tmp/u", LOHRA_HOME: "/tmp/base" })).toBe(
      "/tmp/base/state.db",
    );
    expect(
      stateDatabasePath({ HOME: "/tmp/u", LOHRA_HOME: "/tmp/base", LOHRA_PROFILE: "p1" }),
    ).toBe("/tmp/base/profiles/p1/state.db");
  });

  it("pins busy_timeout to 5000ms by default, hermetic to the host environment", () => {
    const connection = openStateDatabase(temporaryPath(), { environment: {} });
    expect(connection.database.pragma("busy_timeout", { simple: true })).toBe(5000n);
    connection.close();
  });

  it("honors LOHRA_SQLITE_BUSY_TIMEOUT_MS as a non-negative integer override", () => {
    const withOverride = openStateDatabase(temporaryPath(), {
      environment: { LOHRA_SQLITE_BUSY_TIMEOUT_MS: "250" },
    });
    expect(withOverride.database.pragma("busy_timeout", { simple: true })).toBe(250n);
    withOverride.close();

    const zero = openStateDatabase(temporaryPath(), {
      environment: { LOHRA_SQLITE_BUSY_TIMEOUT_MS: "0" },
    });
    expect(zero.database.pragma("busy_timeout", { simple: true })).toBe(0n);
    zero.close();
  });

  it.each(["-1", "abc", "1.5", " ", "1e3", ""])(
    "rejects LOHRA_SQLITE_BUSY_TIMEOUT_MS=%s with a named StateError at connection open",
    (raw) => {
      expect(() =>
        openStateDatabase(temporaryPath(), {
          environment: { LOHRA_SQLITE_BUSY_TIMEOUT_MS: raw },
        }),
      ).toThrow(StateError);
      try {
        openStateDatabase(temporaryPath(), {
          environment: { LOHRA_SQLITE_BUSY_TIMEOUT_MS: raw },
        });
      } catch (error) {
        expect(error).toBeInstanceOf(StateError);
        expect((error as StateError).code).toBe("SQLITE_BUSY_TIMEOUT_INVALID");
      }
    },
  );
});
