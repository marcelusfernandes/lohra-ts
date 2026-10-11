import { describe, expect, it } from "vitest";
import { spawnProcessShell } from "./helpers/process-shell.js";

describe("shell das bancadas de processo", () => {
  it("lança o shell real e preserva stdout, stderr e status", () => {
    const result = spawnProcessShell(["-c", "printf out; printf err >&2"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });
});
