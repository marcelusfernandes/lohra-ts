import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { readExportable } from "../src/skills/export.js";
import { manageSkillInstallation } from "../src/skills/managed-install.js";

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
  let fedSelector = false;
  vi.spyOn(process.stdout, "write").mockImplementation((value) => {
    out += String(value);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((value) => {
    err += String(value);
    const text = String(value);
    const feed = (answer: string): void => {
      queueMicrotask(() => process.stdin.emit("data", Buffer.from(answer)));
    };
    if (text.endsWith(": ") && answers.length) feed(answers.shift() as string);
    else if (!fedSelector && text.includes("Space toggles") && answers.length) {
      fedSelector = true;
      feed(answers.shift() as string);
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
    const f = fixture(["openai\r", "fixture-model\r", "\r"]);
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
    const f = fixture(["openai\r", "fixture-not-a-key\r", "\r"]);
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
      expect(f.output()).not.toContain("Space toggles");
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

  it("offers all four clients without executables and installs only the toggled ones", async () => {
    const f = fixture(["openai\r", "\r", "\x1b[B \r"]);
    const beforeSignals = process.listenerCount("SIGINT");
    try {
      expect(await runCli(["init"])).toBe(0);
      const output = f.output();
      for (const name of ["Claude Code", "Codex", "OpenCode", "Pi"]) expect(output).toContain(name);
      expect(output).toContain("lohra skills remove");
      expect(output).not.toContain("export the use-lohra kit");
      expect(output).not.toContain("also discovers");
      const codex = join(f.base, ".agents", "skills", "use-lohra-ts", "SKILL.md");
      expect(readFileSync(codex, "utf8")).toBe(readExportable("use-lohra-ts"));
      expect(existsSync(join(f.base, ".claude", "skills", "use-lohra-ts"))).toBe(false);
      expect(existsSync(join(f.base, ".config", "opencode", "skills", "use-lohra-ts"))).toBe(false);
      expect(existsSync(join(f.base, ".pi", "agent", "skills", "use-lohra-ts"))).toBe(false);
      expect(existsSync(join(f.base, "codex", "skills", "use-lohra-ts"))).toBe(false);
      expect(f.raw.mock.calls.map((call) => call[0])).toEqual([true, false]);
      expect(process.stdin.listenerCount("data")).toBe(0);
      expect(process.listenerCount("SIGINT")).toBe(beforeSignals);
    } finally {
      f.restore();
    }
  });

  it("installs every selected client from the keyboard", async () => {
    const f = fixture(["openai\r", "\r", " \x1b[B \x1b[B \x1b[B \r"]);
    try {
      expect(await runCli(["init"])).toBe(0);
      for (const file of [
        join(f.base, ".claude", "skills", "use-lohra-ts", "SKILL.md"),
        join(f.base, ".agents", "skills", "use-lohra-ts", "SKILL.md"),
        join(f.base, ".config", "opencode", "skills", "use-lohra-ts", "SKILL.md"),
        join(f.base, ".pi", "agent", "skills", "use-lohra-ts", "SKILL.md"),
      ]) {
        expect(readFileSync(file, "utf8")).toBe(readExportable("use-lohra-ts"));
      }
      expect(f.output()).toContain("OpenCode also discovers skills in");
      expect(f.output()).toContain(join(f.base, ".claude", "skills"));
      expect(f.output()).toContain("Pi also discovers skills in");
    } finally {
      f.restore();
    }
  });

  it("leaves an unchecked install in place", async () => {
    const f = fixture(["openai\r", "\r", "\x1b[B\x1b[B\x1b[B \r"]);
    const claude = join(f.base, ".claude", "skills");
    manageSkillInstallation({ action: "add", skillsDirectory: claude });
    const before = readFileSync(join(claude, "use-lohra-ts", "SKILL.md"), "utf8");
    try {
      expect(await runCli(["init"])).toBe(0);
      expect(readFileSync(join(claude, "use-lohra-ts", "SKILL.md"), "utf8")).toBe(before);
      expect(existsSync(join(f.base, ".pi", "agent", "skills", "use-lohra-ts", "SKILL.md"))).toBe(
        true,
      );
      expect(f.output()).toContain("lohra skills remove");
      expect(f.output()).not.toContain("removed managed");
    } finally {
      f.restore();
    }
  });

  it("reports an install failure with its destination and still installs the others", async () => {
    const f = fixture(["openai\r", "\r", " \x1b[B\x1b[B \r"]);
    const edited = join(f.base, ".config", "opencode", "skills", "use-lohra-ts", "SKILL.md");
    mkdirSync(join(f.base, ".config", "opencode", "skills", "use-lohra-ts"), { recursive: true });
    writeFileSync(edited, "local edit");
    try {
      expect(await runCli(["init"])).toBe(2);
      expect(readFileSync(edited, "utf8")).toBe("local edit");
      expect(existsSync(join(f.base, ".claude", "skills", "use-lohra-ts", "SKILL.md"))).toBe(true);
      expect(existsSync(join(f.base, ".env"))).toBe(true);
      const output = f.output();
      expect(output).toContain(
        `failed to install use-lohra-ts for OpenCode at ${join(f.base, ".config", "opencode", "skills", "use-lohra-ts")}`,
      );
      expect(output).toContain("installed use-lohra-ts for Claude Code");
      expect(output).not.toContain("installed use-lohra-ts for OpenCode");
      expect(output).not.toContain("✓");
      expect(output).toContain("OpenCode also discovers skills in");
    } finally {
      f.restore();
    }
  });

  it.each(["\u0003", "\u0004"])("cancels the client selector before any write", async (control) => {
    const f = fixture(["openai\r", "\r", control]);
    try {
      expect(await runCli(["init"])).toBe(2);
      expect(existsSync(join(f.base, ".env"))).toBe(false);
      expect(existsSync(join(f.base, ".initialized"))).toBe(false);
      expect(existsSync(join(f.base, ".claude"))).toBe(false);
      expect(f.output()).toContain("init interrupted");
      expect(f.output()).not.toContain("installed use-lohra-ts");
      expect(f.raw.mock.calls.map((call) => call[0])).toEqual([true, false]);
      expect(process.stdin.listenerCount("data")).toBe(0);
    } finally {
      f.restore();
    }
  });

  it("confirms an empty selection without installing", async () => {
    const f = fixture(["openai\r", "\r", "\r"]);
    try {
      expect(await runCli(["init"])).toBe(0);
      expect(f.output()).toContain("no clients selected");
      expect(f.output()).toContain("lohra skills remove");
      expect(existsSync(join(f.base, ".claude", "skills", "use-lohra-ts"))).toBe(false);
      expect(existsSync(join(f.base, ".env"))).toBe(true);
    } finally {
      f.restore();
    }
  });
});
