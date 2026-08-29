import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

describe("better-sqlite3", () => {
  it("opens an in-memory database and executes", () => {
    const db = new Database(":memory:");
    const row = db.prepare("select sqlite_version() as v").get() as { v: string };
    db.close();
    expect(row.v).toBeTruthy();
  });
});
