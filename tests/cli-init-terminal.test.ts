import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Keep the existing env writer and replace only the filesystem protection port.
vi.mock("../src/auth/json-file.js", async (original) => ({
  ...(await original<typeof import("../src/auth/json-file.js")>()),
  atomicWritePrivate0600: (path: string, body: string) => {
    writeFileSync(path, body);
  },
}));
vi.mock("../src/doctor/snapshot.js", async (original) => ({
  ...(await original<typeof import("../src/doctor/snapshot.js")>()),
  probeOllamaDown: () => Promise.resolve(false),
}));
import { runCli } from "../src/cli.js";
import { Prompter } from "../src/onboarding/wizard.js";

const originalEnvironment = process.env;
afterEach(() => {
  process.env = originalEnvironment;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(answers: string[], tty = true) {
  const base = mkdtempSync(join(tmpdir(), "lohra-terminal-"));
  process.env = { HOME: base, LOHRA_HOME: base, CODEX_HOME: join(base, "codex"), PATH: "" };
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: tty });
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: tty });
  const raw = vi.fn<(value: boolean) => void>();
  const originalRaw = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");
  Object.defineProperty(process.stdin, "setRawMode", { configurable: true, value: raw });
  const resume = vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
  vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
  let out = "";
  let err = "";
  vi.spyOn(process.stdout, "write").mockImplementation((value) => {
    out += String(value);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((value) => {
    err += String(value);
    if (String(value).endsWith(": ") && answers.length) {
      const answer = answers.shift() as string;
      queueMicrotask(() => process.stdin.emit("data", Buffer.from(answer)));
    }
    return true;
  });
  return {
    base,
    raw,
    resume,
    output: () => out + err,
    restore: () => {
      if (originalRaw) Object.defineProperty(process.stdin, "setRawMode", originalRaw);
      else Reflect.deleteProperty(process.stdin, "setRawMode");
      Reflect.deleteProperty(process.stdin, "isTTY");
      Reflect.deleteProperty(process.stderr, "isTTY");
    },
  };
}

describe("init terminal wiring", () => {
  it("persists a model through the existing writer with an already configured provider", async () => {
    const f = fixture(["openai\r", "fixture-model\r"]);
    process.env.OPENAI_API_KEY = "fixture-not-a-key";
    try {
      expect(await runCli(["init"])).toBe(0);
      expect(readFileSync(join(f.base, ".env"), "utf8")).toContain("LOHRA_MODEL=fixture-model");
      expect(f.output().includes("fixture-not-a-key")).toBe(false);
    } finally {
      f.restore();
    }
  });
  it("does not activate terminal input for unrelated commands", async () => {
    const f = fixture([]);
    try {
      expect(await runCli(["--version"])).toBe(0);
      expect(f.raw).not.toHaveBeenCalled();
      expect(f.resume).not.toHaveBeenCalled();
    } finally {
      f.restore();
    }
  });
  it("default runCli consumes stream answers through the existing protected writer", async () => {
    const f = fixture(["openai\r", "fixture-not-a-key\r"]);
    try {
      expect(await runCli(["init"])).toBe(0);
      const saved = readFileSync(join(f.base, ".env"), "utf8");
      expect(saved.includes("LOHRA_PROVIDER=openai")).toBe(true);
      expect(saved.includes("OPENAI_API_KEY=fixture-not-a-key")).toBe(true);
      expect(f.output().includes("fixture-not-a-key")).toBe(false);
      expect(f.raw.mock.calls.map((call) => call[0])).toEqual([true, false]);
      expect(process.stdin.listenerCount("data")).toBe(0);
    } finally {
      f.restore();
    }
  });
  it.each(["\u0003", "\u0004", "\u001a", "fixture-not-a-key\r\u0003"])(
    "fails before persistence when a key prompt is interrupted",
    async (control) => {
      const f = fixture(["openai\r", control]);
      try {
        expect(await runCli(["init"])).toBe(2);
        expect(existsSync(join(f.base, ".env"))).toBe(false);
        expect(existsSync(join(f.base, ".initialized"))).toBe(false);
        expect(f.output()).toContain("init interrupted");
        expect(f.output()).not.toContain("ready — provider");
      } finally {
        f.restore();
      }
    },
  );
  it.each([true, false])("no-input/nonTTY avoids reads and persistence", async (tty) => {
    const f = fixture([], tty);
    try {
      expect(await runCli(tty ? ["init", "--no-input"] : ["init"])).toBe(0);
      expect(f.resume).not.toHaveBeenCalled();
      expect(f.raw).not.toHaveBeenCalled();
      expect(existsSync(join(f.base, ".env"))).toBe(false);
    } finally {
      f.restore();
    }
  });
  it("preserves synchronous injected readers and accepts async ones", async () => {
    const f = fixture([]);
    try {
      const answers = ["openai", "fixture-not-a-key"];
      expect(
        await runCli(["init"], {
          environment: { ...process.env } as Record<string, string>,
          stdout: () => undefined,
          stderr: () => undefined,
          isTty: true,
          readLine: () => answers.shift() ?? "",
          probeOllama: () => Promise.resolve(false),
        }),
      ).toBe(0);
      expect(
        await new Prompter(
          () => Promise.resolve("yes"),
          () => undefined,
        ).confirm("continue", false),
      ).toBe(true);
    } finally {
      f.restore();
    }
  });
  it("propagates a read failure instead of accepting a default", async () => {
    const prompt = new Prompter(
      () => {
        throw new Error("terminal input ended");
      },
      () => undefined,
    );
    await expect(prompt.ask("provider", "anthropic")).rejects.toThrow("terminal input ended");
  });
});
