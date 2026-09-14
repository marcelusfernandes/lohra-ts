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
): string {
  const lines = [
    "---",
    `name: ${scalar(name)}`,
    `description: ${scalar(description)}`,
    `version: ${scalar(version)}`,
    "---",
    body.trim(),
    "",
  ];
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
  // `platforms` is off the agentskills.io spec and nothing in this runtime
  // ever filtered by it (issue #590; docs/decisions/2026-09-10-skills-harness.md
  // item 7) — dropped as a field, but a legacy `platforms:` list already on
  // disk still parses instead of throwing: its continuation lines are
  // skipped, never surfaced on the returned `Skill`.
  let skippingList = false;
  for (const raw of (match[1] ?? "").split(/\r?\n/u)) {
    if (raw.trim() === "") continue;
    if (skippingList && /^\s*-\s+/u.test(raw)) continue;
    const separator = raw.indexOf(":");
    if (separator <= 0) throw new SkillFormatError("invalid SKILL.md frontmatter: malformed line");
    const key = raw.slice(0, separator).trim();
    const value = raw.slice(separator + 1).trim();
    skippingList = key === "platforms" && value === "";
    if (!skippingList) meta.set(key, unquote(value));
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
  });
}

// Issue #678: last fail-open `catch` in this file after #670
// (`realOrResolved`) and #675 (`ensureWithinRoots`) started naming `path`
// and `code` on stderr instead of swallowing. `ENOENT` stays tolerated — a
// skill root not created yet (e.g. home `skills/` before the first
// `create()`, or a project root that was never set up) is expected, not a
// failure. Any other `code` (EACCES on an unreadable dir, ELOOP on a
// symlink cycle) means the directory genuinely couldn't be read — `warn`
// names `directory` and `code` before the visit returns empty-handed for
// that subtree. The scan does NOT abort: `visit` is called once per root
// from `SkillStore.scan()`'s loop over `this.roots` — one unreadable root
// shouldn't hide skills discoverable through the OTHER roots (pinned by
// the test below), same best-effort posture `scanRoot` already has for a
// malformed `SKILL.md` (`SkillFormatError` → skip, not abort).
function collectSkillFiles(root: string): string[] {
  const output: string[] = [];
  const visit = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        warn(`collectSkillFiles: ${directory} unreadable (${code ?? "unknown error"})`);
      }
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

// Bare stderr line, no level prefix -- mesmo padrão de `src/mcp/manager.ts`'s
// `warn`. `realOrResolved` não recebe (nem passa adiante) um callback de
// `warning` injetável -- nenhum dos dois chamadores (`within` abaixo,
// `isUntrustedPath` em `src/tools/filesystem.ts`) tem um canal desses hoje
// -- então esta é a única saída disponível para nomear a causa (invariante
// 2: falha nunca silenciosa) sem mudar a assinatura pura da função.
function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

// Issue #642: exportada para `src/tools/filesystem.ts` reusar a MESMA régua
// tolerante a ENOENT (sem duplicar) — `isUntrustedPath` media a fronteira do
// projeto com `resolve()`, que não segue symlink.
//
// Issue #670 (residual F3, veredito PR #655 item 4): um erro NÃO-`ENOENT`
// (ex.: `ELOOP` de um ciclo de symlinks, `EACCES` num diretório
// intermediário) significa "o caminho real não pode ser estabelecido" —
// antes disso, o `catch` devolvia `resolve(path)`, que não segue symlink e
// não prova NADA sobre a fronteira: era o mesmo defeito de fail-open que a
// #642 já tinha corrigido para o caso comum. `ENOENT` continua tolerante
// (segue subindo até achar um ancestral que existe) — é o caso legítimo de
// um caminho ainda não criado (`skill_manage create`). `null` é o sinal
// público de "não estabelecido"; `warn` acima nomeia `path` e `code` no
// stderr ANTES de devolver `null` — nunca um `catch` genérico engolindo o
// `code` em silêncio.
export function realOrResolved(path: string): string | null {
  const suffix: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync(current), ...suffix);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        warn(`realOrResolved: ${path} unresolved (${code ?? "unknown error"})`);
        return null;
      }
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

// Issue #670: `null` de qualquer lado (fronteira não estabelecida) fecha —
// nunca "dentro" por padrão.
function within(path: string, root: string): boolean {
  const resolvedRoot = realOrResolved(root);
  const resolvedPath = realOrResolved(path);
  if (resolvedRoot === null || resolvedPath === null) return false;
  const value = relative(resolvedRoot, resolvedPath);
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

  // Issue #675 (residual do veredito PR #674 item 1): mesmo tratamento que
  // #670 deu a `realOrResolved` acima — um erro NÃO-ENOENT ao resolver
  // `parent` (ex.: `ELOOP` de um ciclo de symlinks) significa "a fronteira
  // não pode ser estabelecida", nunca "assume fora e segue". Antes, o
  // `catch` genérico devolvia `resolve(parent)` para QUALQUER erro —
  // fail-open que `within()` fechava logo depois (não explorável hoje), mas
  // silencioso: nada nomeava `parent`/`code`. `ENOENT` continua tolerante
  // (a régua legítima de "diretório ainda não criado" do `create()`).
  private ensureWithinRoots(path: string, name: string): void {
    const parent = dirname(path);
    let resolvedParent: string;
    try {
      resolvedParent = realpathSync(parent);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        warn(`ensureWithinRoots: ${parent} unresolved (${code ?? "unknown error"})`);
        throw new SkillValidationError(`refusing to write '${name}' outside known skill roots`);
      }
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
