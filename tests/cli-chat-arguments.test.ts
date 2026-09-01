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

const usage = `usage: lohra chat [-h] [--profile PROFILE] [--no-input] [--model MODEL]
                  [--provider PROVIDER] [--session SESSION] [--no-tools]
                  [--yolo] [--json] [--max-parallel MAX_PARALLEL]
                  [--max-iterations MAX_ITERATIONS]
                  prompt
`;

describe("chat CLI argument boundary", () => {
  it.each(["2.9", "abc"])(
    "rejects non-integer --max-parallel %s like argparse before runChat",
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
        `${usage}lohra chat: error: argument --max-parallel: invalid int value: '${raw}'\n`,
      );
    },
  );
});
