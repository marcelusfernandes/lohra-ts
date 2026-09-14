import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SkillStore,
  SkillValidationError,
  parseSkillMd,
  realOrResolved,
  renderSkillMd,
} from "../src/skills/index.js";

const roots: string[] = [];
const root = (): string => {
  const value = mkdtempSync(join(tmpdir(), "lohra-skills-"));
  roots.push(value);
  return value;
};
const skill = (rootPath: string, directory: string, name: string, description: string): string => {
  const path = join(rootPath, directory, "SKILL.md");
  mkdirSync(join(rootPath, directory), { recursive: true });
  writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
  return path;
};

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("skill store", () => {
  it("uses project > home > builtin precedence and renders the literal index", () => {
    const home = root();
    const project = root();
    const builtin = root();
    skill(project, "shared", "shared-name", "project version");
    skill(home, "skills/shared", "shared-name", "home version");
    skill(home, "skills/home", "home-only", "only in home");
    skill(builtin, "b", "b-skill", "builtin original");
    const store = new SkillStore(home, [project], [builtin]);
    expect(store.scan().map(({ name }) => name)).toEqual(["shared-name", "home-only", "b-skill"]);
    expect(store.index()).toBe(
      "## Skills (mandatory)\n" +
        "Before answering, scan these. If one is relevant, load it with skill_view(name).\n\n" +
        "- **shared-name** (project): project version\n" +
        "- **home-only**: only in home\n" +
        "- **b-skill** (builtin): builtin original",
    );
  });

  it("skips malformed and symlink entries while retaining a byte-truncated skill", () => {
    const home = root();
    const skills = join(home, "skills");
    mkdirSync(join(skills, "bad"), { recursive: true });
    writeFileSync(join(skills, "bad", "SKILL.md"), "not frontmatter");
    mkdirSync(join(skills, "link"), { recursive: true });
    const target = join(root(), "target.md");
    writeFileSync(target, "---\nname: escaped\n---\nsecret");
    symlinkSync(target, join(skills, "link", "SKILL.md"));
    const prefix = "---\nname: huge\ndescription: large123456789\n---\n";
    mkdirSync(join(skills, "huge"), { recursive: true });
    writeFileSync(join(skills, "huge", "SKILL.md"), prefix + "x".repeat(257_047 - prefix.length));
    const found = new SkillStore(home).scan();
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe("huge");
    expect(found[0]?.body).toHaveLength(255_953);
  });

  it("creates, validates and detects duplicates in one scope", () => {
    const home = root();
    const project = root();
    const store = new SkillStore(home, [project]);
    expect(() => new SkillStore(home).create("x", "d", "b", "1", "project")).toThrow(
      "no project skill dir — run inside a project with .claude/skills",
    );
    store.create("valid-name", "desc", "body", "1.0.0", "project");
    expect(() => store.create("valid-name", "again", "body", "1", "project")).toThrow(
      "skill 'valid-name' already exists in this scope",
    );
    expect(() => store.create("Bad_Name!", "d", "b")).toThrow(
      "invalid skill name 'Bad_Name!': use lowercase letters, digits, hyphens (≤64)",
    );
    expect(() => store.create("x".repeat(65), "d", "b")).toThrow(/invalid skill name/);
    expect(() => store.create("fine", "d".repeat(1025), "b")).toThrow(
      "description over 1024 chars",
    );
  });

  it("updates project in-place, copies builtins on write and deletes home only", () => {
    const home = root();
    const project = root();
    const builtin = root();
    const projectPath = skill(project, "p", "project-one", "project");
    const builtinPath = skill(builtin, "b", "builtin-one", "builtin");
    const original = readFileSync(builtinPath, "utf8");
    const store = new SkillStore(home, [project], [builtin]);
    store.update("project-one", { body: "changed" });
    expect(readFileSync(projectPath, "utf8")).toContain("changed");
    store.update("builtin-one", { description: "home copy" });
    expect(readFileSync(builtinPath, "utf8")).toBe(original);
    expect(store.get("builtin-one")?.description).toBe("home copy");
    expect(store.delete("project-one")).toBe(false);
    expect(store.delete("builtin-one")).toBe(true);
    expect(readFileSync(builtinPath, "utf8")).toBe(original);
  });

  it("freezes the index until a new snapshot", () => {
    const home = root();
    skill(home, "skills/a", "a", "first");
    const store = new SkillStore(home);
    store.loadSnapshot();
    skill(home, "skills/b", "b", "second");
    expect(store.snapshot()).not.toContain("**b**");
    store.loadSnapshot();
    expect(store.snapshot()).toContain("**b**");
  });

  it("round-trips the supported frontmatter fields in insertion order", () => {
    const rendered = renderSkillMd("name", "description", " body ", "1.0.0");
    expect(rendered).toBe("---\nname: name\ndescription: description\nversion: 1.0.0\n---\nbody\n");
  });

  // Issue #590: `platforms` is off the agentskills.io spec and nothing in
  // this runtime ever filtered by it — dropped as a field, but a skill
  // already on disk with a legacy `platforms:` list still parses instead of
  // throwing (docs/decisions/2026-09-10-skills-harness.md item 7).
  it("skips a legacy `platforms:` list instead of throwing or surfacing it", () => {
    const legacy = "---\nname: legacy\ndescription: d\nplatforms:\n- mac\n- win\n---\nbody\n";
    const parsed = parseSkillMd(legacy);
    expect(parsed).not.toHaveProperty("platforms");
    expect(parsed.name).toBe("legacy");
    expect(parsed.description).toBe("d");
  });

  // Issue #670 (residual F3, veredito PR #655 item 4): `realOrResolved`
  // fail-OPEN on any non-ENOENT `realpathSync` error — the `catch` returned
  // `resolve(path)`, which never proves the path is real. A symlink cycle
  // (self-loop: a symlink pointing at itself) makes `realpathSync` throw
  // `ELOOP` — the real path can't be established, so it has to read as
  // "outside", never "inside".
  it("realOrResolved returns null, not a fabricated path, when the real path can't be established (ELOOP cycle, #670)", () => {
    const base = root();
    const loop = join(base, "loop");
    symlinkSync(loop, loop);
    expect(realOrResolved(loop)).toBeNull();
  });

  // Issue #670 (residual F3): `null` alone isn't enough for invariant 2
  // (fault nunca silencioso) — nada além do valor de retorno teria dito por
  // quê. `realOrResolved` nomeia `path` e `code` numa linha de stderr
  // (mesmo padrão bare de `src/mcp/manager.ts`'s `warn`), a única saída
  // disponível: nenhum chamador (`within`, `isUntrustedPath`) tem um canal
  // de `warning` injetável hoje.
  it("names the path and the errno code on stderr before returning null (#670)", () => {
    const base = root();
    const loop = join(base, "loop");
    symlinkSync(loop, loop);
    const original = process.stderr.write.bind(process.stderr);
    const lines: string[] = [];
    process.stderr.write = (chunk: string) => {
      lines.push(chunk);
      return true;
    };
    try {
      expect(realOrResolved(loop)).toBeNull();
    } finally {
      process.stderr.write = original;
    }
    expect(lines.some((line) => line.includes(loop) && line.includes("ELOOP"))).toBe(true);
  });

  // `within()` (private) is what `origin()`/`ensureWithinRoots()` build on
  // top of `realOrResolved` — it isn't exported, and `SkillStore.scan()`
  // never discovers a skill THROUGH a broken directory in the first place
  // (`collectSkillFiles` skips symlink entries and, since #678, warns and
  // skips a `readdirSync` failure instead of discovering anything through
  // it), so the flip can't be observed via a scanned skill's own
  // `origin`. `create()` under a `project` root broken by a symlink cycle
  // IS observable: `ensureWithinRoots` used to treat a root it couldn't
  // resolve as a match anyway (fail-open — `within` said "inside" for a
  // literal string match it never actually verified), letting `mkdirSync`
  // reach the cyclic directory and blow up with a raw `ELOOP` fs error
  // instead of the named `SkillValidationError` refusal.
  it("refuses to create a skill under a project root broken by a symlink cycle, fail-closed (issue #670)", () => {
    const home = root();
    const base = root();
    const loop = join(base, "loop");
    symlinkSync(loop, loop);
    const store = new SkillStore(home, [loop]);
    expect(() => store.create("x", "d", "body", "1.0.0", "project")).toThrow(SkillValidationError);
    expect(() => store.create("x", "d", "body", "1.0.0", "project")).toThrow(
      /outside known skill roots/,
    );
  });

  // Issue #675 (sobra do veredito da PR #674, item 1): `ensureWithinRoots`'s
  // OWN `catch { resolvedParent = resolve(parent); }` was fail-open on any
  // non-ENOENT `realpathSync(parent)` error — the exact shape `#670` removed
  // from `realOrResolved` (`:167-183` above). The test right above already
  // pins that a cyclic PROJECT ROOT ends up refused (`within()` closes the
  // boundary on the root side right after), so the throw itself isn't new;
  // what was silent is `ensureWithinRoots`'s OWN catch never naming the
  // `parent` it couldn't resolve or the errno `code` — nothing on stderr
  // came from `ensureWithinRoots` itself (only `within()`'s own
  // `realOrResolved: <root> unresolved (...)` line, a different string).
  // This pins THAT line, distinguished by an `ensureWithinRoots:` prefix and
  // the exact `parent` path (`<loop>/x`, not the bare root `<loop>`).
  it("ensureWithinRoots warns with its own parent path and code before failing closed (issue #675)", () => {
    const home = root();
    const base = root();
    const loop = join(base, "loop");
    symlinkSync(loop, loop);
    const store = new SkillStore(home, [loop]);
    const parent = join(loop, "x");
    const original = process.stderr.write.bind(process.stderr);
    const lines: string[] = [];
    process.stderr.write = (chunk: string) => {
      lines.push(chunk);
      return true;
    };
    try {
      expect(() => store.create("x", "d", "body", "1.0.0", "project")).toThrow(
        SkillValidationError,
      );
    } finally {
      process.stderr.write = original;
    }
    expect(
      lines.some(
        (line) =>
          line.includes("ensureWithinRoots") && line.includes(parent) && line.includes("ELOOP"),
      ),
    ).toBe(true);
  });

  // Issue #678: `collectSkillFiles`'s own `catch { return; }` around
  // `readdirSync` was the last fail-open swallow in this file after #670
  // (`realOrResolved`) and #675 (`ensureWithinRoots`) started naming path
  // and code — a skills dir broken by ELOOP/EACCES just vanished, no line
  // on stderr. `scan()` iterates every root (`this.roots`), so one broken
  // root shouldn't hide skills discoverable through the OTHER roots — the
  // warn names it and the scan keeps going, best-effort, same as `origin()`
  // already tolerates a root it can't fully resolve.
  it("warns collectSkillFiles's own path and code on a readdirSync failure other than ENOENT, then keeps scanning (#678)", () => {
    const home = root();
    const base = root();
    const loop = join(base, "loop");
    symlinkSync(loop, loop);
    skill(home, "ok", "ok-skill", "still found");
    const store = new SkillStore(home, [loop]);
    const original = process.stderr.write.bind(process.stderr);
    const lines: string[] = [];
    process.stderr.write = (chunk: string) => {
      lines.push(chunk);
      return true;
    };
    let skills;
    try {
      skills = store.scan();
    } finally {
      process.stderr.write = original;
    }
    expect(
      lines.some(
        (line) =>
          line.includes("collectSkillFiles") && line.includes(loop) && line.includes("ELOOP"),
      ),
    ).toBe(true);
    expect(skills.map((entry) => entry.name)).toContain("ok-skill");
  });

  // ENOENT stays tolerated — a skill root that doesn't exist yet (e.g. the
  // home `skills/` dir before the first `create()`) is a legitimate,
  // expected case, not a failure to name on stderr.
  it("does not warn on ENOENT — a skill root that hasn't been created yet is tolerated", () => {
    const home = root();
    const missing = join(root(), "does-not-exist");
    const store = new SkillStore(home, [missing]);
    const original = process.stderr.write.bind(process.stderr);
    const lines: string[] = [];
    process.stderr.write = (chunk: string) => {
      lines.push(chunk);
      return true;
    };
    let skills;
    try {
      skills = store.scan();
    } finally {
      process.stderr.write = original;
    }
    expect(skills).toEqual([]);
    expect(lines).toHaveLength(0);
  });
});
