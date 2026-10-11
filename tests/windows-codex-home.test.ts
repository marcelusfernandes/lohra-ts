import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCodexHome } from "../src/config/paths.js";

describe("Codex home on Windows without HOME", () => {
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
});
