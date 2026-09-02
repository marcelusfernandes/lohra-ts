import process from "node:process";

import { describe, expect, it } from "vitest";

import {
  runPythonProcess,
  runTypeScriptProcess,
  type ProcessRequest,
} from "../../scripts/parity/process.js";

const request: ProcessRequest = {
  executable: process.execPath,
  argv: [
    "--input-type=module",
    "-e",
    'process.stdout.write("out"); process.stderr.write("err"); process.exit(7)',
  ],
  cwd: process.cwd(),
  environment: { PATH: process.env.PATH ?? "" },
};

describe("process adapters", () => {
  it("preserves exit code, stdout and stderr in the TypeScript adapter", () => {
    expect(runTypeScriptProcess(request)).toEqual({
      exitCode: 7,
      signal: null,
      stdout: Buffer.from("out").toString("base64"),
      stderr: Buffer.from("err").toString("base64"),
    });
  });

  it("preserves exit code, stdout and stderr in the Python adapter", () => {
    expect(
      runPythonProcess(request, {
        pythonExecutable: process.env.PYTHON ?? "python3",
      }),
    ).toEqual({
      exitCode: 7,
      signal: null,
      stdout: Buffer.from("out").toString("base64"),
      stderr: Buffer.from("err").toString("base64"),
    });
  });
});
