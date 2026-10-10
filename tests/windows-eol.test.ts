import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const samples = [
  "package.json",
  ".github/workflows/ci.yml",
  "src/conversation/runtime.ts",
  "tests/workflow-hardening.test.ts",
  "tests/fixtures/parity/scenarios/ts-doctor-invalid-order.json",
  "docs/investigations/windows/consolidation.md",
];

describe("Windows checkout line endings", () => {
  it("keeps code, fixture and formatter inputs LF with core.autocrlf=true", () => {
    const scratch = mkdtempSync(join(tmpdir(), "lohra-windows-eol-"));
    const clone = join(scratch, "clone");
    try {
      execFileSync("git", ["-c", "core.autocrlf=true", "clone", "--quiet", root, clone], {
        timeout: 30_000,
      });

      const listed = execFileSync("git", ["ls-files", "--eol", "--", ...samples], {
        cwd: clone,
        encoding: "utf8",
      });
      for (const file of samples) {
        const line = listed.split("\n").find((entry) => entry.endsWith(`\t${file}`));
        expect(line, file).toMatch(/i\/lf\s+w\/lf\s+attr\/.*eol=lf\t/);

        const bytes = readFileSync(join(clone, file));
        expect(bytes.includes(Buffer.from("\r\n")), file).toBe(false);
        expect(bytes.includes(10), file).toBe(true);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 60_000);
});
