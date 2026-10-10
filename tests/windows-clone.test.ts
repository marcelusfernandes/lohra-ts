import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("Windows default checkout", () => {
  it("does not track the reserved AUX basename and keeps the auxiliary module", () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root })
      .toString("utf8")
      .split("\0");

    expect(tracked).not.toContain("src/agent/aux.ts");
    expect(tracked).toContain("src/agent/auxiliary.ts");
  });

  it("routes runtime imports and mutation catalogs to the portable module name", () => {
    expect(source("src/agent/index.ts")).toContain('export * from "./auxiliary.js"');

    for (const file of [
      "src/commands/chat.ts",
      "src/commands/dashboard.ts",
      "src/conversation/runtime.ts",
      "src/conversation/compaction.ts",
    ]) {
      expect(source(file)).not.toContain('agent/aux.js"');
      expect(source(file)).toContain('agent/auxiliary.js"');
    }

    for (const file of [
      "scripts/mutations/context-window.ts",
      "scripts/mutations/context-prompt-mutants.ts",
    ]) {
      expect(source(file)).not.toContain('"src/agent/aux.ts"');
      expect(source(file)).toContain('"src/agent/auxiliary.ts"');
    }
  });
});
