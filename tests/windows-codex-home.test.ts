import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readCodexTokens } from "../src/auth/codex.js";
import { resolveCodexHome } from "../src/config/paths.js";

describe("Codex home on Windows without HOME", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const systemHome = join("fixture", "system-user");
  const suppliedHome = join("fixture", "supplied-user");
  const explicitCodex = join("fixture", "explicit-codex");
  const isolatedLohra = join("fixture", "isolated-lohra");

  it.each([undefined, ""])("uses the system home when HOME is %s", (home) => {
    expect(resolveCodexHome({ HOME: home, LOHRA_HOME: isolatedLohra }, systemHome)).toBe(
      join(systemHome, ".codex"),
    );
  });

  it("preserves HOME and explicit CODEX_HOME precedence", () => {
    expect(resolveCodexHome({ HOME: suppliedHome }, systemHome)).toBe(join(suppliedHome, ".codex"));
    expect(
      resolveCodexHome(
        { HOME: suppliedHome, CODEX_HOME: explicitCodex, LOHRA_HOME: isolatedLohra },
        systemHome,
      ),
    ).toBe(explicitCodex);
  });

  it("finds a fictional Codex login under a controlled system home", () => {
    const systemHome = mkdtempSync(join(tmpdir(), "lohra-codex-home-"));
    roots.push(systemHome);
    const codexHome = join(systemHome, ".codex");
    mkdirSync(codexHome);
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: "FAKE" } }),
    );

    const resolved = resolveCodexHome({ LOHRA_HOME: join(systemHome, "lohra") }, systemHome);
    expect(resolved).toBe(codexHome);
    expect(readCodexTokens(resolved)?.accessToken).toBe("FAKE");
  });
});
