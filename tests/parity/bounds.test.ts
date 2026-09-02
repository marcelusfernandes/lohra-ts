import process from "node:process";

import { describe, expect, it } from "vitest";

import { runPythonProcess, runTypeScriptProcess } from "../../scripts/parity/process.js";

const base = {
  executable: process.execPath,
  cwd: process.cwd(),
  environment: { PATH: "/usr/bin:/bin" },
};

describe("bounded process execution", () => {
  it.each([
    ["typescript", runTypeScriptProcess],
    [
      "python",
      (request: Parameters<typeof runPythonProcess>[0]) =>
        runPythonProcess(request, { pythonExecutable: process.env.PYTHON ?? "python3" }),
    ],
  ])("turns a %s timeout into a named harness failure", (_name, run) => {
    expect(() =>
      run({
        ...base,
        argv: ["--input-type=module", "-e", "setTimeout(() => {}, 5000)"],
        timeoutMs: 100,
        maxOutputBytes: 1024,
      }),
    ).toThrow(expect.objectContaining({ code: "PROCESS_TIMEOUT" }));
  });

  it.each([
    ["typescript", runTypeScriptProcess],
    [
      "python",
      (request: Parameters<typeof runPythonProcess>[0]) =>
        runPythonProcess(request, { pythonExecutable: process.env.PYTHON ?? "python3" }),
    ],
  ])("turns %s output overflow into a named harness failure", (_name, run) => {
    expect(() =>
      run({
        ...base,
        argv: ["--input-type=module", "-e", 'process.stdout.write("x".repeat(10000))'],
        timeoutMs: 2000,
        maxOutputBytes: 128,
      }),
    ).toThrow(expect.objectContaining({ code: "PROCESS_OUTPUT_LIMIT" }));
  });
});
