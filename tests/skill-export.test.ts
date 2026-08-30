import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { listExportable, writeExportable } from "../src/skills/export.js";

describe("exportable skill kit", () => {
  it("ships separately and copies byte-for-byte", () => {
    expect(listExportable()).toEqual(["use-lohra"]);
    const destination = mkdtempSync(join(tmpdir(), "lohra-export-test-"));
    const output = writeExportable("use-lohra", destination);
    expect(output).toBe(join(destination, "use-lohra", "SKILL.md"));
    expect(readFileSync(output, "utf8")).toContain("name: use-lohra");
  });

  it("fails before touching the destination for unknown kits", () => {
    const destination = mkdtempSync(join(tmpdir(), "lohra-export-test-"));
    expect(() => writeExportable("no-such-kit", destination)).toThrow(
      "no exportable skill 'no-such-kit' — available: ['use-lohra']",
    );
  });
});
