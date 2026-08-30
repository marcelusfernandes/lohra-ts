import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { captureObservables } from "../../scripts/parity/capture.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("observable capture", () => {
  it("records missing configured SQLite and event captures as exists false", () => {
    const profile = mkdtempSync(join(tmpdir(), "lohra-parity-missing-capture-"));
    temporaryDirectories.push(profile);
    const capture = captureObservables(profile, {
      tree: { enabled: false, root: "profile", exclude: [] },
      sqlite: [
        {
          name: "missing-db",
          root: "profile",
          path: "missing.db",
          pragmas: [],
          tables: [],
        },
      ],
      events: [{ name: "missing-events", root: "profile", path: "missing.jsonl", format: "jsonl" }],
    });

    expect(capture.sqlite["missing-db"]).toEqual({ exists: false });
    expect(capture.events["missing-events"]).toEqual({ exists: false });
  });

  it("captures a deterministic tree, SQLite state and JSONL events", () => {
    const profile = mkdtempSync(join(tmpdir(), "lohra-parity-capture-"));
    temporaryDirectories.push(profile);
    mkdirSync(join(profile, "nested"));
    writeFileSync(join(profile, "nested", "fixture.txt"), "fixture\n");
    writeFileSync(join(profile, "events.jsonl"), '{"kind":"started","sequence":1}\n');

    const database = new Database(join(profile, "state.db"));
    database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    database.prepare("INSERT INTO items (id, value) VALUES (?, ?)").run(1, "one");
    database.pragma("user_version = 3");
    database.close();

    const capture = captureObservables(profile, {
      tree: {
        enabled: true,
        root: "profile",
        exclude: ["state.db", "events.jsonl"],
      },
      sqlite: [
        {
          name: "state",
          root: "profile",
          path: "state.db",
          pragmas: ["user_version"],
          tables: [{ name: "items", orderBy: ["id"] }],
        },
      ],
      events: [{ name: "lifecycle", root: "profile", path: "events.jsonl", format: "jsonl" }],
    });

    expect(capture.tree).toEqual([
      { path: "nested", type: "directory" },
      {
        path: "nested/fixture.txt",
        type: "file",
        size: 8,
        sha256: "e80b71cd14d3cbd65f4173abcbfcf01a545dbca32a72d575108b553a648cc96f",
      },
    ]);
    expect(capture.sqlite.state).toMatchObject({
      exists: true,
      pragmas: { user_version: { type: "integer", decimal: "3" } },
      tables: {
        items: {
          rows: [[{ type: "integer", decimal: "1" }, "one"]],
        },
      },
    });
    expect(capture.events.lifecycle).toEqual({
      exists: true,
      records: [{ kind: "started", sequence: 1 }],
    });
  });

  it("preserves SQLite storage classes including integral REAL and BLOB", () => {
    const profile = mkdtempSync(join(tmpdir(), "lohra-parity-storage-capture-"));
    temporaryDirectories.push(profile);
    const database = new Database(join(profile, "typed.db"));
    database.exec("CREATE TABLE typed_values (id INTEGER PRIMARY KEY, n, i, r, t, b BLOB)");
    database
      .prepare("INSERT INTO typed_values VALUES (?, ?, CAST(? AS INTEGER), CAST(? AS REAL), ?, ?)")
      .run(1, null, 42, 0, "café — state", Buffer.from([0x00, 0xff, 0x80, 0x41]));
    database.close();

    const capture = captureObservables(profile, {
      tree: { enabled: false, root: "profile", exclude: [] },
      sqlite: [
        {
          name: "typed",
          root: "profile",
          path: "typed.db",
          pragmas: [],
          tables: [{ name: "typed_values", orderBy: ["id"] }],
        },
      ],
      events: [],
    });

    expect(capture.sqlite.typed).toMatchObject({
      exists: true,
      tables: {
        typed_values: {
          rows: [
            [
              { type: "integer", decimal: "1" },
              null,
              { type: "integer", decimal: "42" },
              { type: "real", value: 0 },
              "café — state",
              { type: "blob", base64: "AP+AQQ==" },
            ],
          ],
        },
      },
    });
  });
});
