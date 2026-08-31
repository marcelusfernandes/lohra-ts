import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSystemPrompt,
  discoverInstructions,
  discoverSkillRoots,
  findProjectRoot,
  loadProjectContext,
} from "../src/context/index.js";

const roots: string[] = [];
const root = (): string => {
  const value = mkdtempSync(join(tmpdir(), "lohra-context-"));
  roots.push(value);
  return value;
};

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("project discovery", () => {
  it("prefers VCS markers in a separate pass and shadows instructions nearest-first", () => {
    const repo = root();
    const nested = join(repo, "backend", "pkg");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "root agents");
    writeFileSync(join(repo, "CLAUDE.md"), "root claude");
    writeFileSync(join(repo, "backend", "pyproject.toml"), "");
    writeFileSync(join(nested, "AGENTS.md"), "near agents");
    expect(findProjectRoot(nested)).toBe(realpathSync(repo));
    expect(discoverInstructions(nested)).toEqual([
      ["backend/pkg/AGENTS.md", "near agents"],
      ["CLAUDE.md", "root claude"],
    ]);
  });

  it("treats .claude as a root marker and returns existing skill roots in order", () => {
    const repo = root();
    const nested = join(repo, "nested");
    mkdirSync(join(nested, ".claude", "skills"), { recursive: true });
    mkdirSync(join(nested, ".lohra", "skills"), { recursive: true });
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "outside");
    expect(findProjectRoot(nested)).toBe(realpathSync(nested));
    expect(discoverInstructions(nested)).toEqual([]);
    expect(discoverSkillRoots(nested)).toEqual([
      join(realpathSync(nested), ".claude", "skills"),
      join(realpathSync(nested), ".lohra", "skills"),
    ]);
  });

  it("caps the walk at 25 ancestors without signalling", () => {
    const repo = root();
    mkdirSync(join(repo, ".git"));
    let leaf = repo;
    for (let index = 0; index < 40; index += 1) leaf = join(leaf, `d${String(index)}`);
    mkdirSync(leaf, { recursive: true });
    expect(findProjectRoot(leaf)).toBe(realpathSync(leaf));
  });

  it("caps bytes before characters and preserves the astral missing-marker behavior", () => {
    const repo = root();
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, "AGENTS.md"), "a".repeat(32_500));
    expect(discoverInstructions(repo)[0]?.[1]).toHaveLength(32_016);
    writeFileSync(join(repo, "AGENTS.md"), "😀".repeat(32_500));
    const astral = discoverInstructions(repo)[0]?.[1] ?? "";
    expect(Array.from(astral)).toHaveLength(32_000);
    expect(astral).not.toContain("[...truncated]");
  });

  it("skips symlink instructions and fails closed for a non-ancestral root", () => {
    const repo = root();
    const outside = root();
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(outside, "secret"), "OPERATOR-CANARY");
    symlinkSync(join(outside, "secret"), join(repo, "AGENTS.md"));
    expect(discoverInstructions(repo)).toEqual([]);
    expect(() => discoverInstructions(repo, outside)).toThrow("PROJECT_ROOT_NOT_ANCESTOR");
  });

  it("distinguishes nonexistent success from a real resolution failure", () => {
    const missing = join(root(), "not-created");
    const success = loadProjectContext(missing);
    expect(success.instructions).toEqual([]);
    const resolvedMissing = join(realpathSync(dirname(missing)), basename(missing));
    expect(success.hints).toEqual({ cwd: resolvedMissing, project_root: resolvedMissing });

    const received = "x".repeat(1024);
    const failed = loadProjectContext(received, () => {
      throw Object.assign(new Error("name too long"), { code: "ENAMETOOLONG" });
    });
    expect(failed).toEqual({ instructions: [], hints: { cwd: received } });
  });
});

describe("system prompt renderer", () => {
  it("is immutable and byte-stable for already materialized inputs", () => {
    const prompt = buildSystemPrompt({
      identity: "Soul",
      environmentHints: { z: "last", a: "first" },
      systemMessage: " caller ",
      contextFiles: [["AGENTS.md", "instructions"]],
      memorySnapshot: "remember",
      userProfile: "person",
      skillsIndex: "skills",
      today: "2030-01-02",
    });
    expect(prompt.text).toContain('<context-file name="AGENTS.md">\ninstructions\n</context-file>');
    expect(prompt.text).toContain("<memory>\nremember\n</memory>");
    expect(prompt.text).toContain("Today's date is 2030-01-02.");
    expect(Object.isFrozen(prompt)).toBe(true);
    expect(() => {
      (prompt as { stable: string }).stable = "changed";
    }).toThrow(TypeError);
  });

  it("falls back to the LOCAL calendar date, not UTC, inside the daily window where they disagree", () => {
    // A same-day "today vs today" comparison passes 21 hours out of 24 and
    // proves nothing — the real regression only shows up inside the window
    // between local midnight and UTC midnight. 00:25 UTC on 2026-08-31 is
    // 21:25 local on 2026-08-30 in America/Sao_Paulo (fixed UTC-3, no DST
    // since Brazil abolished it in 2019), matching the oracle's
    // `datetime.date.today()` (local calendar date), not
    // `toISOString()` (UTC calendar date).
    const originalTz = process.env.TZ;
    process.env.TZ = "America/Sao_Paulo";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T00:25:00Z"));
    try {
      const prompt = buildSystemPrompt({});
      expect(prompt.text).toContain("Today's date is 2026-08-30.");
      expect(prompt.text).not.toContain("Today's date is 2026-08-31.");
    } finally {
      vi.useRealTimers();
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});
