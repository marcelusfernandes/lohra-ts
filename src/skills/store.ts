import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { readTextBounded } from "../context/discovery.js";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const DESCRIPTION_LIMIT = 1024;
const MAX_SKILL_BYTES = 256_000;
const RESERVED_SCALAR_CHARACTERS = [
  ":",
  "#",
  "[",
  "]",
  "{",
  "}",
  "&",
  ",",
  "*",
  "!",
  "|",
  ">",
  "'",
  '"',
  "%",
  "@",
  "`",
] as const;

export class SkillError extends Error {}
export class SkillFormatError extends SkillError {}
export class SkillValidationError extends SkillError {}

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly body: string;
  readonly path?: string;
  readonly platforms: readonly string[];
}

function scalar(value: string): string {
  if (
    value === "" ||
    /^\s|\s$/u.test(value) ||
    RESERVED_SCALAR_CHARACTERS.some((character) => value.includes(character))
  ) {
    return `'${value.replaceAll("'", "''")}'`;
  }
  return value;
}

export function renderSkillMd(
  name: string,
  description: string,
  body: string,
  version: string,
  platforms: readonly string[] = [],
): string {
  const lines = [
    "---",
    `name: ${scalar(name)}`,
    `description: ${scalar(description)}`,
    `version: ${scalar(version)}`,
  ];
  if (platforms.length > 0)
    lines.push("platforms:", ...platforms.map((entry) => `- ${scalar(entry)}`));
  lines.push("---", body.trim(), "");
  return lines.join("\n");
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      throw new SkillFormatError("invalid SKILL.md frontmatter: invalid quoted scalar");
    }
  }
  return trimmed;
}

export function parseSkillMd(content: string, path?: string): Skill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(content);
  if (match === null) {
    throw new SkillFormatError("SKILL.md must start with a YAML frontmatter block (--- ... ---)");
  }
  const meta = new Map<string, string>();
  const platforms: string[] = [];
  let list = false;
  for (const raw of (match[1] ?? "").split(/\r?\n/u)) {
    if (raw.trim() === "") continue;
    if (list && /^\s*-\s+/u.test(raw)) {
      platforms.push(unquote(raw.replace(/^\s*-\s+/u, "")));
      continue;
    }
    const separator = raw.indexOf(":");
    if (separator <= 0) throw new SkillFormatError("invalid SKILL.md frontmatter: malformed line");
    const key = raw.slice(0, separator).trim();
    const value = raw.slice(separator + 1).trim();
    list = key === "platforms" && value === "";
    if (!list) meta.set(key, unquote(value));
  }
  const name = meta.get("name");
  if (name === undefined || name.length === 0) {
    throw new SkillFormatError("SKILL.md frontmatter must define a 'name'");
  }
  return Object.freeze({
    name,
    description: meta.get("description") ?? "",
    version: meta.get("version") ?? "",
    body: (match[2] ?? "").trim(),
    ...(path === undefined ? {} : { path }),
    platforms: Object.freeze([...platforms]),
  });
}

function collectSkillFiles(root: string): string[] {
  const output: string[] = [];
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === "SKILL.md") output.push(path);
    }
  };
  visit(root);
  return output.sort();
}

function realOrResolved(path: string): string {
  const suffix: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return resolve(path);
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

function within(path: string, root: string): boolean {
  const value = relative(realOrResolved(root), realOrResolved(path));
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

export interface SkillUpdate {
  readonly description?: string;
  readonly body?: string;
  readonly version?: string;
}

export class SkillStore {
  readonly root: string;
  private readonly projectRoots: readonly string[];
  private readonly builtinRoots: readonly string[];
  private readonly roots: readonly string[];
  private loaded?: string;

  constructor(
    home: string,
    projectRoots: readonly string[] = [],
    builtinRoots: readonly string[] = [],
  ) {
    this.root = join(home, "skills");
    this.projectRoots = [...projectRoots];
    this.builtinRoots = [...builtinRoots];
    this.roots = [...projectRoots, this.root, ...builtinRoots];
  }

  private scanRoot(root: string): Skill[] {
    return collectSkillFiles(root).flatMap((path) => {
      const content = readTextBounded(path, MAX_SKILL_BYTES);
      if (content === undefined) return [];
      try {
        return [parseSkillMd(content, path)];
      } catch (error) {
        if (error instanceof SkillFormatError) return [];
        throw error;
      }
    });
  }

  scan(): Skill[] {
    const seen = new Set<string>();
    const output: Skill[] = [];
    for (const root of this.roots) {
      for (const skill of this.scanRoot(root)) {
        if (seen.has(skill.name)) continue;
        seen.add(skill.name);
        output.push(skill);
      }
    }
    return output;
  }

  get(name: string): Skill | undefined {
    return this.scan().find((skill) => skill.name === name);
  }

  private origin(skill: Skill): "project" | "home" | "builtin" {
    if (skill.path === undefined || within(skill.path, this.root)) return "home";
    if (this.builtinRoots.some((root) => within(skill.path as string, root))) return "builtin";
    return "project";
  }

  private ensureWithinRoots(path: string, name: string): void {
    const parent = dirname(path);
    let resolvedParent: string;
    try {
      resolvedParent = realpathSync(parent);
    } catch {
      resolvedParent = resolve(parent);
    }
    const resolved = join(resolvedParent, basename(path));
    if (!this.roots.some((root) => within(resolved, root))) {
      throw new SkillValidationError(`refusing to write '${name}' outside known skill roots`);
    }
  }

  create(
    name: string,
    description: string,
    body: string,
    version = "1.0.0",
    scope = "home",
  ): Skill {
    if (!NAME_PATTERN.test(name)) {
      throw new SkillValidationError(
        `invalid skill name '${name}': use lowercase letters, digits, hyphens (≤64)`,
      );
    }
    if (description.length > DESCRIPTION_LIMIT) {
      throw new SkillValidationError(`description over ${String(DESCRIPTION_LIMIT)} chars`);
    }
    const root = scope === "project" ? this.projectRoots[0] : this.root;
    if (root === undefined) {
      throw new SkillValidationError(
        "no project skill dir — run inside a project with .claude/skills",
      );
    }
    if (this.scanRoot(root).some((skill) => skill.name === name)) {
      throw new SkillValidationError(`skill '${name}' already exists in this scope`);
    }
    const path = join(root, name, "SKILL.md");
    this.ensureWithinRoots(path, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderSkillMd(name, description, body, version), "utf8");
    return parseSkillMd(readFileSync(path, "utf8"), path);
  }

  update(name: string, update: SkillUpdate): Skill {
    const existing = this.get(name);
    if (existing?.path === undefined) throw new SkillValidationError(`no skill named '${name}'`);
    if (!this.roots.some((root) => within(existing.path as string, root))) {
      throw new SkillValidationError(`skill '${name}' is outside known skill roots`);
    }
    const description = update.description ?? existing.description;
    if (description.length > DESCRIPTION_LIMIT) {
      throw new SkillValidationError(`description over ${String(DESCRIPTION_LIMIT)} chars`);
    }
    const path =
      this.origin(existing) === "builtin"
        ? join(this.root, existing.name, "SKILL.md")
        : existing.path;
    this.ensureWithinRoots(path, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      renderSkillMd(
        name,
        description,
        update.body ?? existing.body,
        update.version ?? (existing.version || "1.0.0"),
        existing.platforms,
      ),
      "utf8",
    );
    return parseSkillMd(readFileSync(path, "utf8"), path);
  }

  delete(name: string): boolean {
    const skill = this.scanRoot(this.root).find((entry) => entry.name === name);
    if (skill?.path === undefined) return false;
    rmSync(dirname(skill.path), { recursive: true, force: true });
    return true;
  }

  index(): string {
    const skills = this.scan();
    if (skills.length === 0) return "";
    const labels = { project: " (project)", home: "", builtin: " (builtin)" } as const;
    return [
      "## Skills (mandatory)",
      "Before answering, scan these. If one is relevant, load it with skill_view(name).",
      "",
      ...skills.map(
        (skill) => `- **${skill.name}**${labels[this.origin(skill)]}: ${skill.description}`,
      ),
    ].join("\n");
  }

  loadSnapshot(): void {
    this.loaded = this.index();
  }

  snapshot(): string {
    if (this.loaded === undefined) this.loadSnapshot();
    return this.loaded ?? "";
  }
}
