import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SkillStore, parseSkillMd, renderSkillMd } from "../src/skills/index.js";

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
    const rendered = renderSkillMd("name", "description", " body ", "1.0.0", ["mac", "win"]);
    expect(rendered).toBe(
      "---\nname: name\ndescription: description\nversion: 1.0.0\nplatforms:\n- mac\n- win\n---\nbody\n",
    );
    expect(parseSkillMd(rendered).platforms).toEqual(["mac", "win"]);
  });
});
