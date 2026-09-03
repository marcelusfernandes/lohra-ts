import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

describe("T22 public documentation", () => {
  it("documents the exact public CLI and current package", () => {
    const readme = read("README.md");
    expect(readme, "MUTATION_CAUSE:T22-docs-current-version").toContain(
      "A versão atual é `0.0.11`.",
    );
    const expected = [
      "init",
      "doctor",
      "chat",
      "dashboard",
      "serve",
      "cron",
      "workflow",
      "models",
      "tiers",
      "profile",
      "auth",
      "skill",
      "update",
    ];
    const documented = /Os comandos top-level públicos[\s\S]*?`update`\./u
      .exec(readme)?.[0]
      .match(/`([a-z-]+)`/gu)
      ?.map((value) => value.slice(1, -1));
    expect(documented).toEqual(expected);
    expect(readme).toContain("não existe\n`workflow run`");
    expect(readme).toContain("não\nembute nem chama Python");
    expect(readme).toContain("NOT_MEASURED");
  });

  it("records 23 tickets, approved SHAs, debts and owner rulings", () => {
    const closeout = read("docs/closeout.md");
    const tickets = closeout.match(/^\| T(?:0[0-9]|1[0-9]|2[0-2])\s+\|/gmu) ?? [];
    expect(tickets).toHaveLength(23);
    expect(closeout).toContain("D2 / L22");
    expect(closeout).toContain("D3 / M4 e M4-bis");
    expect(closeout).toContain("P2");
    expect(closeout).toContain("NOT_MEASURED");
    expect(closeout).toContain("PENDING_FINAL_SHA");
  });

  it("has no broken relative Markdown links in public docs", () => {
    for (const path of ["README.md", "docs/closeout.md"]) {
      const text = read(path);
      for (const match of text.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)]+)\)/gu)) {
        const target = match[1];
        if (target === undefined) continue;
        expect(
          existsSync(resolve(root, dirname(path), target)),
          `MUTATION_CAUSE:T22-doc-link:${path}:${target}`,
        ).toBe(true);
      }
    }
  });
});
