import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MEMORY_CHAR_LIMIT,
  MemoryFile,
  MemoryStore,
  USER_CHAR_LIMIT,
  parseMemory,
  renderMemory,
} from "../src/memory/index.js";

const roots: string[] = [];
const root = (): string => {
  const value = mkdtempSync(join(tmpdir(), "lohra-memory-"));
  roots.push(value);
  return value;
};

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("memory files", () => {
  it("parses tolerant delimiters and renders the canonical delimiter", () => {
    expect(parseMemory("one§two")).toEqual(["one", "two"]);
    expect(parseMemory("one\n\n§\n\ntwo")).toEqual(["one", "two"]);
    expect(parseMemory("cost is 50§ per unit")).toEqual(["cost is 50", "per unit"]);
    expect(parseMemory(" § \n")).toEqual([]);
    expect(renderMemory(["one", "two"])).toBe("one\n§\ntwo");
  });

  it("counts Unicode code points, including the delimiter", () => {
    const path = join(root(), "MEMORY.md");
    const file = new MemoryFile(path, MEMORY_CHAR_LIMIT);
    file.add("😀".repeat(1101));
    expect(file.render()).toHaveLength(2202);
    expect(Array.from(file.render())).toHaveLength(1101);
    expect(() => {
      file.replace("😀", "x".repeat(2201));
    }).toThrow("memory would be 2201 chars, over the 2200 budget");
    const exact = new MemoryFile(join(root(), "exact.md"), 7);
    exact.add("ab");
    exact.add("cd");
    expect(exact.render()).toBe("ab\n§\ncd");
    expect(() => {
      exact.add("e");
    }).toThrow("memory would be 11 chars, over the 7 budget");
  });

  it("is idempotent and reports unique-substring failures", () => {
    const file = new MemoryFile(join(root(), "MEMORY.md"), MEMORY_CHAR_LIMIT);
    file.add(" first ");
    file.add("first");
    file.add("second firstish");
    expect(file.entries()).toEqual(["first", "second firstish"]);
    expect(() => {
      file.remove("missing");
    }).toThrow("no memory entry contains 'missing'");
    expect(() => {
      file.replace("first", "x");
    }).toThrow("2 entries contain 'first'; be more specific");
  });

  it("keeps defensive snapshots frozen until reloaded", () => {
    const home = root();
    const store = new MemoryStore(home);
    store.memory.add("before");
    store.user.add("person");
    store.loadSnapshot();
    const first = store.snapshot() as { memory: string; user: string };
    expect(() => {
      first.memory = "tampered";
    }).toThrow(TypeError);
    store.memory.add("after");
    expect(store.snapshot()).toEqual({ memory: "before", user: "person" });
    store.loadSnapshot();
    expect(store.snapshot()).toEqual({ memory: "before\n§\nafter", user: "person" });
  });

  it("uses the two contracted limits and leaves the destination intact on overflow", () => {
    const home = root();
    const store = new MemoryStore(home);
    expect(store.memory.charLimit).toBe(MEMORY_CHAR_LIMIT);
    expect(store.user.charLimit).toBe(USER_CHAR_LIMIT);
    store.memory.add("kept");
    expect(() => {
      store.memory.add("x".repeat(2200));
    }).toThrow();
    expect(readFileSync(join(home, "memories", "MEMORY.md"), "utf8")).toBe("kept");
  });

  it("normalizes an existing noncanonical file on mutation", () => {
    const directory = root();
    const path = join(directory, "MEMORY.md");
    writeFileSync(path, "one§two");
    const file = new MemoryFile(path, MEMORY_CHAR_LIMIT);
    file.add("three");
    expect(readFileSync(path, "utf8")).toBe("one\n§\ntwo\n§\nthree");
  });
});
