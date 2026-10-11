import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { evaluateRun, realExecute } from "../scripts/mutations/all.js";

const originalNpmExecpath = process.env.npm_execpath;
const originalFakeExit = process.env.FAKE_MUTATION_EXIT;
const roots: string[] = [];

afterEach(() => {
  if (originalNpmExecpath === undefined) delete process.env.npm_execpath;
  else process.env.npm_execpath = originalNpmExecpath;
  if (originalFakeExit === undefined) delete process.env.FAKE_MUTATION_EXIT;
  else process.env.FAKE_MUTATION_EXIT = originalFakeExit;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeNpm(script: string): { readonly root: string; readonly cli: string } {
  const root = mkdtempSync(join(tmpdir(), "lohra mutation npm & "));
  roots.push(root);
  const cli = join(root, "npm cli & literal.js");
  writeFileSync(cli, script);
  process.env.npm_execpath = cli;
  return { root, cli };
}

describe("mutation npm caller", () => {
  it("runs the selected npm CLI without shell and preserves script, cwd, stderr and exit status", () => {
    const { root } = fakeNpm(
      "const {writeSync}=require('node:fs');writeSync(1,JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()}));writeSync(2,'SLICE_STDERR');process.exit(Number(process.env.FAKE_MUTATION_EXIT));",
    );
    process.env.FAKE_MUTATION_EXIT = "7";
    const run = realExecute("slice with spaces & literal", { cwd: root, timeoutMs: 5_000 });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(7);
    expect(run.signal).toBeNull();
    expect(run.stderr).toBe("SLICE_STDERR");
    expect(JSON.parse(run.stdout)).toEqual({
      argv: ["run", "slice with spaces & literal"],
      cwd: root,
    });
  });

  it("returns an npm resolution error instead of treating it as a nonzero slice result", () => {
    const { root } = fakeNpm("");
    process.env.npm_execpath = join(root, "missing npm-cli.js");
    const run = realExecute("slice", { cwd: root, timeoutMs: 5_000 });
    expect(run.status).toBeNull();
    expect(run.signal).toBeNull();
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
    expect(run.error?.message).toMatch(/NPM_CLI_NOT_FOUND/u);
    expect(() => evaluateRun(run, "first")).toThrow(/NPM_CLI_NOT_FOUND/u);
  });

  it("preserves timeout as ETIMEDOUT with the kill signal", () => {
    const { root } = fakeNpm("setTimeout(() => {}, 5000);");
    const run = realExecute("slow", { cwd: root, timeoutMs: 300 });
    expect(run.status).toBeNull();
    expect(run.signal).toBe("SIGTERM");
    expect((run.error as NodeJS.ErrnoException | undefined)?.code).toBe("ETIMEDOUT");
    expect(() => evaluateRun(run, "first")).toThrow(/^MUTATION_ALL_TIMEOUT:first$/u);
  }, 10_000);
});
