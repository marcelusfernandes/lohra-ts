import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { applyEnvFile, parseEnvText } from "../src/config/env-file.js";
import { resolvePaths, validateProfileName } from "../src/config/paths.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("profile paths and env file", () => {
  it("uses LOHRA_HOME verbatim and keeps .env at the base when profiled", () => {
    expect(resolvePaths({ HOME: "/user", LOHRA_HOME: "/custom", LOHRA_PROFILE: "myprof" })).toEqual(
      {
        base: "/custom",
        home: "/custom/profiles/myprof",
        envFile: "/custom/.env",
        profile: "myprof",
      },
    );
  });

  it("rejects traversal, Unicode and oversized profile names", () => {
    for (const name of ["..", "bad/profile", "café", "-leading", "x".repeat(65)]) {
      expect(() => validateProfileName(name)).toThrow(/invalid profile name/);
    }
  });

  it("parses the Python env-file subset and never overwrites a real variable", () => {
    expect(parseEnvText("# comment\nexport A='one'\nB=two=three\n\n")).toEqual({
      A: "one",
      B: "two=three",
    });
    const root = mkdtempSync(join(tmpdir(), "lohra-env-file-"));
    temporaryDirectories.push(root);
    mkdirSync(root, { recursive: true });
    const path = join(root, ".env");
    writeFileSync(path, "A=from-file\nB=from-file\n");
    const env: Record<string, string> = { A: "" };
    expect(applyEnvFile(path, env)).toEqual(["B"]);
    expect(env).toEqual({ A: "", B: "from-file" });
  });
});
