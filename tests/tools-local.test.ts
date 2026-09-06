import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ApprovalManager,
  parseToolArguments,
  readFileTool,
  terminalTool,
  writeFileTool,
} from "../src/tools/index.js";

const roots: string[] = [];
const root = (): string => {
  const path = mkdtempSync(join(tmpdir(), "lohra-tools-"));
  roots.push(path);
  return path;
};

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("filesystem tools", () => {
  it("reads UTF-8 and truncates at 100,000 Unicode code points", () => {
    const path = join(root(), "astral.txt");
    writeFileSync(path, "😀".repeat(100_001));
    const result = JSON.parse(readFileTool({ path })) as {
      data: string;
      truncated: boolean;
      path: string;
    };
    expect(result.truncated).toBe(true);
    expect(Array.from(result.data)).toHaveLength(100_000);
    expect(result.data).toHaveLength(200_000);
    expect(result.path).toBe(path);
  });

  it("distinguishes missing, directory, and invalid UTF-8 inputs", () => {
    const directory = root();
    expect(readFileTool({})).toBe('{"error":"missing required argument \'path\'"}');
    expect(readFileTool({ path: join(directory, "missing") })).toContain("file not found:");
    expect(readFileTool({ path: directory })).toContain("path is a directory:");
    const binary = join(directory, "binary");
    writeFileSync(binary, Buffer.from([0xff, 0xfe]));
    expect(readFileTool({ path: binary })).toContain("file is not valid UTF-8 text:");
  });

  it("writes parent directories, UTF-8 bytes, and validates content", () => {
    const path = join(root(), "sub", "out.txt");
    expect(writeFileTool({ path, content: "café 😀" })).toBe(
      `{"ok":true,"bytes_written":10,"path":"${path}"}`,
    );
    expect(readFileSync(path, "utf8")).toBe("café 😀");
    expect(writeFileTool({ path })).toBe('{"error":"missing required argument \'content\'"}');
    expect(writeFileTool({ path, content: 1 })).toBe('{"error":"\'content\' must be a string"}');
  });
});

describe("terminal tool", () => {
  it("returns stdout, stderr and nonzero exits", async () => {
    const approval = new ApprovalManager();
    const result = JSON.parse(
      await terminalTool(
        { command: "printf out; printf err >&2; exit 7" },
        { approvalManager: approval },
      ),
    ) as { stdout: string; stderr: string; exit_code: number };
    expect(result).toEqual({ ok: true, stdout: "out", stderr: "err", exit_code: 7 });
  });

  it("gates dangerous commands before execution", async () => {
    const directory = root();
    const sentinel = join(directory, "sentinel");
    const command = `sudo touch ${sentinel}`;
    expect(await terminalTool({ command }, { approvalManager: new ApprovalManager() })).toBe(
      `{"error":"command was not approved by the user","command":"${command}"}`,
    );
    expect(() => readFileSync(sentinel)).toThrow();
  });

  it.each([
    ['{"command":"sleep 4","timeout":1}', "1s"],
    ['{"command":"sleep 4","timeout":1.0}', "1.0s"],
    ['{"command":"sleep 4","timeout":2.50}', "2.5s"],
    ['{"command":"sleep 4","timeout":1e0}', "1.0s"],
    ['{"command":"sleep 4","timeout":true}', "Trues"],
    ['{"command":"sleep 4","timeout":0}', "0s"],
  ])("renders Python timeout semantics for %s", async (raw, rendered) => {
    const args = parseToolArguments(raw);
    const result = await terminalTool(args, { approvalManager: new ApprovalManager() });
    expect(result).toContain(`command timed out after ${rendered}`);
  });

  it("treats null timeout as disabled", async () => {
    const result = JSON.parse(
      await terminalTool(parseToolArguments('{"command":"printf ok","timeout":null}'), {
        approvalManager: new ApprovalManager(),
      }),
    ) as { stdout: string };
    expect(result.stdout).toBe("ok");
  });

  it("truncates each stream by code point", async () => {
    const directory = root();
    const script = join(directory, "emit.mjs");
    writeFileSync(
      script,
      'process.stdout.write("😀".repeat(50001)); process.stderr.write("😀".repeat(50001));',
    );
    const result = JSON.parse(
      await terminalTool(
        { command: `node ${JSON.stringify(script)}` },
        { approvalManager: new ApprovalManager() },
      ),
    ) as { stdout: string; stderr: string };
    expect(Array.from(result.stdout)).toHaveLength(50_000);
    expect(Array.from(result.stderr)).toHaveLength(50_000);
    expect(result.stdout).toHaveLength(100_000);
    expect(result.stderr).toHaveLength(100_000);
  });

  it("validates command type before the gate", async () => {
    const directory = root();
    mkdirSync(join(directory, "kept"));
    expect(await terminalTool({ command: ["sudo", "x"] })).toBe(
      '{"error":"missing required argument \'command\' (string)"}',
    );
  });
});
