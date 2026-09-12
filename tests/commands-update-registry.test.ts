// Issue #533 (D4 do épico #529): `src/commands/update-registry.ts` é módulo
// novo — inexistente na base, então cada `it` importa dinamicamente (a
// coleta do arquivo não pode falhar por um `import` estático de símbolo
// ausente; o vermelho tem que vir do `throw new Error("not implemented…")`
// dentro do teste, não de um erro de coleta do vitest).
import { describe, expect, it, vi } from "vitest";

import type {
  InstallRunner,
  RegistryFetch,
  RegistryFetchResponse,
  RegistryUpdateOptions,
} from "../src/commands/update-registry.js";

function fakeResponse(body: unknown, ok = true, status = 200): RegistryFetchResponse {
  return { ok, status, json: () => Promise.resolve(body) };
}

function baseOptions(
  overrides: Partial<RegistryUpdateOptions> & {
    readonly fetchImpl: RegistryFetch;
  },
): RegistryUpdateOptions {
  const runner: InstallRunner = vi.fn(() => ({ code: 0, stdout: "", stderr: "" }));
  return {
    check: true,
    yes: false,
    currentVersion: "1.0.0",
    runner,
    cwd: "/home/user",
    stdout: vi.fn(),
    stderr: vi.fn(),
    ...overrides,
  };
}

describe("update-registry", () => {
  it("reports a newer version on --check without installing", async () => {
    const { runRegistryUpdate } = await import("../src/commands/update-registry.js");
    const fetchImpl: RegistryFetch = vi.fn(() =>
      Promise.resolve(fakeResponse({ version: "1.2.0" })),
    );
    const options = baseOptions({ fetchImpl, check: true, currentVersion: "1.0.0" });
    const code = await runRegistryUpdate(options);
    expect(code).toBe(0);
    expect(options.stdout).toHaveBeenCalledWith(expect.stringContaining("1.2.0"));
    expect(options.runner).not.toHaveBeenCalled();
  });

  it("reports up to date when the registry version matches the installed one", async () => {
    const { runRegistryUpdate } = await import("../src/commands/update-registry.js");
    const fetchImpl: RegistryFetch = vi.fn(() =>
      Promise.resolve(fakeResponse({ version: "1.0.0" })),
    );
    const options = baseOptions({ fetchImpl, check: true, currentVersion: "1.0.0" });
    const code = await runRegistryUpdate(options);
    expect(code).toBe(0);
    expect(options.stdout).toHaveBeenCalledWith(expect.stringContaining("up to date"));
    expect(options.runner).not.toHaveBeenCalled();
  });

  it("fails closed, naming the cause, when the registry is unavailable", async () => {
    const { runRegistryUpdate } = await import("../src/commands/update-registry.js");
    const fetchImpl: RegistryFetch = vi.fn(() =>
      Promise.reject(new Error("getaddrinfo ENOTFOUND")),
    );
    const options = baseOptions({ fetchImpl, check: true });
    const code = await runRegistryUpdate(options);
    expect(code).toBe(1);
    expect(options.stdout).not.toHaveBeenCalled();
    expect(options.stderr).toHaveBeenCalledWith(expect.stringContaining("ENOTFOUND"));
  });

  it("fails closed on a non-ok registry response", async () => {
    const { runRegistryUpdate } = await import("../src/commands/update-registry.js");
    const fetchImpl: RegistryFetch = vi.fn(() => Promise.resolve(fakeResponse(null, false, 503)));
    const options = baseOptions({ fetchImpl, check: true });
    const code = await runRegistryUpdate(options);
    expect(code).toBe(1);
    expect(options.stderr).toHaveBeenCalledWith(expect.stringContaining("503"));
  });

  it("--yes installs by executable/argv (no shell) when a newer version exists", async () => {
    const { runRegistryUpdate } = await import("../src/commands/update-registry.js");
    const calls: Array<{ executable: string; args: readonly string[]; cwd: string }> = [];
    const runner: InstallRunner = (executable, args, cwd) => {
      calls.push({ executable, args, cwd });
      return { code: 0, stdout: "", stderr: "" };
    };
    const fetchImpl: RegistryFetch = vi.fn(() =>
      Promise.resolve(fakeResponse({ version: "1.2.0" })),
    );
    const options = baseOptions({
      fetchImpl,
      check: false,
      yes: true,
      currentVersion: "1.0.0",
      runner,
      cwd: "/home/user",
    });
    const code = await runRegistryUpdate(options);
    expect(code).toBe(0);
    expect(calls).toEqual([
      { executable: "npm", args: ["install", "-g", "lohra-ts@1.2.0"], cwd: "/home/user" },
    ]);
  });

  it("reports npm install failure without swallowing it", async () => {
    const { runRegistryUpdate } = await import("../src/commands/update-registry.js");
    const runner: InstallRunner = vi.fn(() => ({ code: 1, stdout: "", stderr: "EACCES" }));
    const fetchImpl: RegistryFetch = vi.fn(() =>
      Promise.resolve(fakeResponse({ version: "1.2.0" })),
    );
    const options = baseOptions({ fetchImpl, check: false, yes: true, runner });
    const code = await runRegistryUpdate(options);
    expect(code).toBe(1);
    expect(options.stderr).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
  });

  it("without --yes only prints the exact command and exits 0", async () => {
    const { runRegistryUpdate } = await import("../src/commands/update-registry.js");
    const fetchImpl: RegistryFetch = vi.fn(() =>
      Promise.resolve(fakeResponse({ version: "1.2.0" })),
    );
    const options = baseOptions({ fetchImpl, check: false, yes: false, currentVersion: "1.0.0" });
    const code = await runRegistryUpdate(options);
    expect(code).toBe(0);
    expect(options.stdout).toHaveBeenCalledWith("npm install -g lohra-ts@1.2.0\n");
    expect(options.runner).not.toHaveBeenCalled();
  });

  it("compareVersions is fail-closed on non x.y.z input", async () => {
    const { compareVersions } = await import("../src/commands/update-registry.js");
    expect(() => compareVersions("1.0", "1.2.0")).toThrow();
    expect(() => compareVersions("1.0.0", "1.2.0-beta")).toThrow();
  });

  it("compareVersions orders correctly", async () => {
    const { compareVersions } = await import("../src/commands/update-registry.js");
    expect(compareVersions("1.0.0", "1.2.0")).toBe("newer");
    expect(compareVersions("1.2.0", "1.2.0")).toBe("equal");
    expect(compareVersions("1.2.1", "1.2.0")).toBe("older");
  });

  it("npmInstallArgs builds the exact argv, never a shell string", async () => {
    const { npmInstallArgs } = await import("../src/commands/update-registry.js");
    expect(npmInstallArgs("1.2.0")).toEqual(["install", "-g", "lohra-ts@1.2.0"]);
  });

  it("readInstalledVersion reads the version from the package's own package.json", async () => {
    const { readInstalledVersion } = await import("../src/commands/update-registry.js");
    const { readFileSync } = await import("node:fs");
    const expected = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string })
      .version;
    expect(readInstalledVersion()).toBe(expected);
  });
});
