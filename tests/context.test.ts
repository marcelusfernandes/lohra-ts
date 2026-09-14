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

  // Issue #582 (épico #575, P6): AGENTS.md e CLAUDE.md byte-idênticos no
  // mesmo diretório entram como um `<context-file>` só — a issue mede 96%
  // de um prompt deste repositório vindo dos dois duplicados.
  it("dedupes identical content into one entry with a composite label", () => {
    const repo = root();
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "shared instructions");
    writeFileSync(join(repo, "CLAUDE.md"), "shared instructions");
    expect(discoverInstructions(repo)).toEqual([["AGENTS.md = CLAUDE.md", "shared instructions"]]);
  });

  it("keeps two entries when AGENTS.md and CLAUDE.md differ", () => {
    const repo = root();
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "agents text");
    writeFileSync(join(repo, "CLAUDE.md"), "claude text");
    expect(discoverInstructions(repo)).toEqual([
      ["AGENTS.md", "agents text"],
      ["CLAUDE.md", "claude text"],
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
    // Issue #588 (épico #575, P12): `loadProjectContext` ganhou hints de
    // ambiente sempre presentes (`platform`, `node`, `shell`) além de
    // `cwd`/`project_root` — o snapshot de git é coberto à parte em
    // `tests/context-discovery.test.ts` (precisa de um repositório real ou
    // de um `git` falso, fora do escopo deste teste de resolução de path).
    expect(success.hints.cwd).toBe(resolvedMissing);
    expect(success.hints.project_root).toBe(resolvedMissing);
    expect(success.hints.platform).toBe(process.platform);
    expect(success.hints.node).toBe(process.version);
    expect(success.hints).not.toHaveProperty("git_branch");

    const received = "x".repeat(1024);
    const failed = loadProjectContext(received, () => {
      throw Object.assign(new Error("name too long"), { code: "ENAMETOOLONG" });
    });
    expect(failed.instructions).toEqual([]);
    expect(failed.hints.cwd).toBe(received);
    expect(failed.hints.platform).toBe(process.platform);
    expect(failed.hints).not.toHaveProperty("project_root");
    expect(failed.hints).not.toHaveProperty("git_branch");
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

  // Issue #646 (sub-issue A1 de #637, veredito da PR #614): a byte-compat do
  // prompt sem blocos opcionais era pinada só por AUSÊNCIA (`not.toContain`
  // nos testes de moldura abaixo) — nunca por igualdade exata do `.text`
  // inteiro. Um mutante que trocasse a ordem das faixas, o separador, ou
  // inserisse um byte a mais sobreviveria a todos os `toContain`/`not.
  // toContain` já existentes.
  it("pins the whole .text of a prompt with no optional blocks by equality (issue #646)", () => {
    const prompt = buildSystemPrompt({ identity: "Soul", today: "2030-01-02" });
    expect(prompt.text).toBe("Soul\n\nToday's date is 2030-01-02.");
  });

  it("places doctrine in the stable band, after identity and before Environment (issue #579)", () => {
    const prompt = buildSystemPrompt({
      identity: "Soul",
      doctrine: "DOCTRINE-TEXT",
      environmentHints: { cwd: "/tmp" },
      today: "2030-01-02",
    });
    const identityIndex = prompt.stable.indexOf("Soul");
    const doctrineIndex = prompt.stable.indexOf("DOCTRINE-TEXT");
    const environmentIndex = prompt.stable.indexOf("Environment:");
    expect(identityIndex).toBeGreaterThanOrEqual(0);
    expect(doctrineIndex).toBeGreaterThan(identityIndex);
    expect(environmentIndex).toBeGreaterThan(doctrineIndex);
  });

  it("omits doctrine entirely when not provided — stable band unchanged from before #579", () => {
    const prompt = buildSystemPrompt({ identity: "Soul", today: "2030-01-02" });
    expect(prompt.stable).toBe("Soul");
  });

  it("places harness in the stable band, after doctrine and before Environment (issue #580)", () => {
    const prompt = buildSystemPrompt({
      identity: "Soul",
      doctrine: "DOCTRINE-TEXT",
      harness: "HARNESS-TEXT",
      environmentHints: { cwd: "/tmp" },
      today: "2030-01-02",
    });
    const doctrineIndex = prompt.stable.indexOf("DOCTRINE-TEXT");
    const harnessIndex = prompt.stable.indexOf("HARNESS-TEXT");
    const environmentIndex = prompt.stable.indexOf("Environment:");
    expect(doctrineIndex).toBeGreaterThanOrEqual(0);
    expect(harnessIndex).toBeGreaterThan(doctrineIndex);
    expect(environmentIndex).toBeGreaterThan(harnessIndex);
  });

  it("omits harness entirely when not provided — stable band unchanged from before #580", () => {
    const prompt = buildSystemPrompt({
      identity: "Soul",
      doctrine: "DOCTRINE-TEXT",
      today: "2030-01-02",
    });
    expect(prompt.stable).toBe("Soul\n\nDOCTRINE-TEXT");
  });

  // Issue #588 (épico #575, P12): a última linha do bloco `Environment:` é a
  // nota de que o snapshot foi tirado no início da sessão e não se atualiza.
  it("appends the snapshot note when at least one environment hint is present", () => {
    const prompt = buildSystemPrompt({
      environmentHints: { cwd: "/tmp" },
      today: "2030-01-02",
    });
    expect(prompt.stable).toContain(
      "Snapshot taken at session start; it does not update during the conversation.",
    );
    expect(prompt.stable.trimEnd().endsWith("does not update during the conversation.")).toBe(true);
  });

  it("omits the snapshot note entirely when there are no environment hints", () => {
    const prompt = buildSystemPrompt({ identity: "Soul", today: "2030-01-02" });
    expect(prompt.stable).not.toContain("Snapshot taken at session start");
    expect(prompt.stable).toBe("Soul");
  });

  it("indents a multi-line hint value instead of breaking the '- key: value' shape", () => {
    const prompt = buildSystemPrompt({
      environmentHints: { cwd: "/tmp", git_status: "M a.txt\n?? b.txt" },
      today: "2030-01-02",
    });
    expect(prompt.stable).toContain("- git_status:\n  M a.txt\n  ?? b.txt");
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

// Issue #582 (épico #575, P6): moldura para memória, perfil e instruções
// de projeto — uma frase de autoridade/uso antes de cada tag, ausente
// quando o bloco correspondente está ausente.
describe("prefix frames for memory, user profile, and project instructions (#582)", () => {
  it("prefixes <memory> with what it is and that it may be stale", () => {
    const prompt = buildSystemPrompt({ memorySnapshot: "remember this", today: "2030-01-02" });
    expect(prompt.volatile).toMatch(
      /durable facts you saved in earlier sessions[^]*\n\n<memory>\nremember this\n<\/memory>/,
    );
  });

  it("omits the memory prefix when there is no memory snapshot", () => {
    const prompt = buildSystemPrompt({ today: "2030-01-02" });
    expect(prompt.volatile).not.toContain("durable facts you saved in earlier sessions");
    expect(prompt.volatile).not.toContain("<memory>");
  });

  it("prefixes <user-profile> with who it describes", () => {
    const prompt = buildSystemPrompt({ userProfile: "likes tabs", today: "2030-01-02" });
    expect(prompt.volatile).toMatch(
      /who the user is and how they prefer to work\.\n\n<user-profile>\nlikes tabs\n<\/user-profile>/,
    );
  });

  it("omits the user-profile prefix when there is no user profile", () => {
    const prompt = buildSystemPrompt({ today: "2030-01-02" });
    expect(prompt.volatile).not.toContain("who the user is and how they prefer to work");
    expect(prompt.volatile).not.toContain("<user-profile>");
  });

  it("prefixes the project instruction files once, before the whole group", () => {
    const prompt = buildSystemPrompt({
      contextFiles: [
        ["AGENTS.md", "one"],
        ["CLAUDE.md", "two"],
      ],
      today: "2030-01-02",
    });
    const prefixIndex = prompt.context.indexOf("override default behavior");
    const firstFileIndex = prompt.context.indexOf('<context-file name="AGENTS.md">');
    expect(prefixIndex).toBeGreaterThanOrEqual(0);
    expect(firstFileIndex).toBeGreaterThan(prefixIndex);
    expect(prompt.context.match(/override default behavior/gu)).toHaveLength(1);
  });

  it("omits the project-instructions prefix when there are no context files", () => {
    const prompt = buildSystemPrompt({ systemMessage: "caller message", today: "2030-01-02" });
    expect(prompt.context).not.toContain("override default behavior");
  });
});
