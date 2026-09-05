import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

interface CommandHook {
  readonly type: string;
  readonly command: string;
}

interface HookGroup {
  readonly matcher?: string;
  readonly hooks: readonly CommandHook[];
}

interface ProjectSettings {
  readonly permissions?: { readonly allow?: readonly string[] };
  readonly hooks?: Readonly<Record<string, readonly HookGroup[]>>;
  readonly worktree?: { readonly symlinkDirectories?: readonly string[] };
}

const root = resolve(import.meta.dirname, "..");
const settingsPath = resolve(root, ".claude", "settings.json");
const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as ProjectSettings;
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  readonly scripts: Readonly<Record<string, string>>;
};

const allow = settings.permissions?.allow ?? [];

const REQUIRED_ALLOW = [
  "Bash(npm run typecheck)",
  "Bash(npm run build)",
  "Bash(npm test)",
  "Bash(npm run lint)",
  "Bash(npm run format:check)",
  "Bash(npx vitest run:*)",
  "Bash(git status:*)",
  "Bash(git log:*)",
  "Bash(git diff:*)",
  "Bash(git show:*)",
  "Bash(sqlite3 -readonly:*)",
];

// Fora da allowlist de propósito: escrevem na árvore inteira, mexem no git ou
// são longos / com rede. Um falso positivo aqui é preferível a liberar sem querer.
const FORBIDDEN_PATTERNS = [
  /^Bash\(npm run format\)?$/u,
  /^Bash\(git (commit|push|checkout|reset|rebase)/u,
  /parity:/u,
  /smoke:/u,
  /mutations:/u,
];

describe(".claude/settings.json", () => {
  it("declares exactly one PostToolUse hook group for Edit|Write, backed by the format script", () => {
    const groups = settings.hooks?.PostToolUse ?? [];
    const editWrite = groups.filter((group) => group.matcher === "Edit|Write|MultiEdit");
    expect(editWrite).toHaveLength(1);
    const commands = editWrite[0]?.hooks.filter((hook) => hook.type === "command") ?? [];
    expect(commands).toHaveLength(1);
    expect(commands[0]?.command).toContain(".claude/hooks/format-file.sh");
  });

  it("guards the session: protege-main on Bash, protege-escrita on Edit|Write, stop-gate on Stop", () => {
    const pre = settings.hooks?.PreToolUse ?? [];
    const bash = pre.filter((group) => group.matcher === "Bash");
    expect(bash).toHaveLength(1);
    expect(bash[0]?.hooks.map((hook) => hook.command).join()).toContain(
      ".claude/hooks/protege-main.sh",
    );
    const write = pre.filter((group) => group.matcher === "Edit|Write|MultiEdit|NotebookEdit");
    expect(write).toHaveLength(1);
    expect(write[0]?.hooks.map((hook) => hook.command).join()).toContain(
      ".claude/hooks/protege-escrita.sh",
    );
    const stop = settings.hooks?.Stop ?? [];
    expect(stop).toHaveLength(1);
    expect(stop[0]?.hooks.map((hook) => hook.command).join()).toContain(
      ".claude/hooks/stop-gate.sh",
    );
    // tsc + `npm run prova` da branch: o timeout do tsc-check (120s) não basta
    expect(stop[0]?.hooks[0]?.timeout ?? 0).toBeGreaterThanOrEqual(300);
  });

  it("links node_modules into agent worktrees (skill worktree-segura, section A)", () => {
    expect(settings.worktree?.symlinkDirectories).toEqual(["node_modules"]);
  });

  it("allows the read-only development commands the repo considers safe", () => {
    for (const rule of REQUIRED_ALLOW) expect(allow).toContain(rule);
  });

  it("never allows commands that mutate the tree, the git history, or run long lanes", () => {
    for (const rule of allow) {
      for (const pattern of FORBIDDEN_PATTERNS) expect(rule).not.toMatch(pattern);
    }
  });

  it("only allows `npm run <script>` for scripts that exist in package.json", () => {
    const scriptNames = Object.keys(packageJson.scripts);
    for (const rule of allow) {
      const match = /^Bash\(npm run ([^ )]+)\)$/u.exec(rule);
      if (match === null) continue;
      expect(scriptNames, `allowlist references missing script: ${rule}`).toContain(match[1]);
    }
  });
});
