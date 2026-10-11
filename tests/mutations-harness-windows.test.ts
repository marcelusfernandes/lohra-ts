import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runFocusedVitest, runVitestFiles } from "../scripts/mutations/harness.js";

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function realVitestFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "lohra Vitest café "));
  scratch.push(directory);
  mkdirSync(join(directory, "node_modules"));
  symlinkSync(
    resolve(import.meta.dirname, "../node_modules/vitest"),
    join(directory, "node_modules/vitest"),
    "dir",
  );
  // The fixture deliberately has no executable shim: the installed JS entrypoint
  // must work with a cwd containing spaces and Unicode on every platform.
  expect(existsSync(join(directory, "node_modules/.bin/vitest"))).toBe(false);
  writeFileSync(
    join(directory, "fixture.test.ts"),
    [
      'import { expect, it } from "vitest";',
      'it("green (literal) café", () => expect(2 + 2).toBe(4));',
      'it("red", () => expect(2 + 2).toBe(5));',
    ].join("\n"),
  );
  return directory;
}

describe("mutation harness invokes installed Vitest", () => {
  it("runs a real green and red fixture without a shell shim", () => {
    const directory = realVitestFixture();
    expect(runVitestFiles(directory, ["fixture.test.ts"])).toEqual({
      exitCode: 1,
      failedTests: ["red"],
      ranTests: 2,
    });
  }, 30_000);

  it("preserves the focused test title as one argv item", () => {
    const directory = realVitestFixture();
    expect(
      runFocusedVitest(directory, { file: "fixture.test.ts", test: "green (literal) café" }),
    ).toEqual({
      exitCode: 0,
      failedTests: [],
      ranTests: 1,
    });
  }, 30_000);

  it("reports a missing installed entrypoint as a launch failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "lohra Vitest missing "));
    scratch.push(directory);
    const packageDir = join(directory, "node_modules/vitest");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), '{"bin":{"vitest":"./missing.mjs"}}');
    expect(() => runVitestFiles(directory, ["fixture.test.ts"])).toThrow(
      /no JSON report \(exitCode=1\): .*Cannot find module.*missing\.mjs/is,
    );
  });

  it("preserves stderr and exit status when no report exists, then removes scratch", () => {
    const directory = mkdtempSync(join(tmpdir(), "lohra Vitest no report "));
    scratch.push(directory);
    const packageDir = join(directory, "node_modules/vitest");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), '{"bin":{"vitest":"./vitest.mjs"}}');
    writeFileSync(
      join(packageDir, "vitest.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        'const report = process.argv.find((arg) => arg.startsWith("--outputFile="))?.slice(13);',
        `writeFileSync(${JSON.stringify(join(directory, "report-location.txt"))}, report ?? "");`,
        'console.error("fixture Vitest launch failed");',
        "process.exitCode = 7;",
      ].join("\n"),
    );
    expect(() => runVitestFiles(directory, ["fixture.test.ts"])).toThrow(
      /no JSON report \(exitCode=7\): fixture Vitest launch failed/i,
    );
    const reportPath = readFileSync(join(directory, "report-location.txt"), "utf8");
    expect(existsSync(dirname(reportPath))).toBe(false);
  });
});
