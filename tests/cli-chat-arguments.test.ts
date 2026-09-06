import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "lohra-t13-cli-chat-"));
  roots.push(value);
  return value;
}

const usage = "usage: lohra chat [options]\n";

describe("chat CLI argument boundary", () => {
  it.each(["2.9", "abc"])(
    "rejects non-integer --max-parallel %s before runChat ever sees it",
    async (raw) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runCli(
        [
          "chat",
          "hello",
          "--provider",
          "ollama",
          "--model",
          "stub-coder:1b",
          "--max-parallel",
          raw,
        ],
        {
          environment: { HOME: home(), PATH: "/usr/bin:/bin" },
          stdout: (value) => stdout.push(value),
          stderr: (value) => stderr.push(value),
        },
      );

      expect(code).toBe(2);
      expect(stdout.join("")).toBe("");
      expect(stderr.join("")).toBe(
        `${usage}lohra: error: option --max-parallel expects an integer, got "${raw}"\n`,
      );
    },
  );
});
