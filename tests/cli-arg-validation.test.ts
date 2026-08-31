import { describe, expect, it } from "vitest";

import { validateArgs, chatTypeErrorMessage, CHAT_USAGE_BANNER } from "../src/cli/arg-validation.js";
import { CHAT_SPEC, DOCTOR_SPEC, MODELS_SPEC } from "../src/cli/arg-spec.js";
import { runCli, type CliIo } from "../src/cli.js";

// Every expected byte sequence below was captured [fio] against the real
// oracle CLI (backend/lohra/cli.py, argparse-based) in an isolated, hermetic
// HOME with `env -i`, not inferred from reading the Python source. The
// oracle never writes to stdout when rejecting arguments — even under
// --json — so every rejection assertion below pins stdout to "".

function invoke(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    environment: { HOME: "/tmp/lohra-cli-arg-validation-unused", PATH: "/usr/bin:/bin" },
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    probeOllama: () => Promise.resolve(false),
  };
  return runCli(argv, io).then((code) => ({ code, stdout: stdout.join(""), stderr: stderr.join("") }));
}

const TOP_LEVEL_USAGE =
  "usage: lohra [-h] [--version]\n" +
  "             {init,doctor,chat,dashboard,serve,cron,workflow,models,tiers,profile,auth,skill,update}\n" +
  "             ...\n";

describe("validateArgs (unit)", () => {
  it("flags a completely unknown flag", () => {
    expect(validateArgs(DOCTOR_SPEC, ["--frobnicate"])).toEqual({
      unrecognized: ["--frobnicate"],
      typeError: null,
    });
  });

  it("flags an extra positional once the command's positional slots are full", () => {
    expect(validateArgs(DOCTOR_SPEC, ["bogus-positional"])).toEqual({
      unrecognized: ["bogus-positional"],
      typeError: null,
    });
  });

  it("does not let an unknown flag consume the next token as its value — reproducing the oracle's own collection order", () => {
    // Oracle: `chat --frobnicate x --no-input --json oi` -> unrecognized: --frobnicate oi
    // "x" fills the one positional slot (prompt); "oi" has nowhere left to go.
    expect(validateArgs(CHAT_SPEC, ["--frobnicate", "x", "--no-input", "--json", "oi"])).toEqual({
      unrecognized: ["--frobnicate", "oi"],
      typeError: null,
    });
  });

  it("recognizes a declared flag not previously tracked (--max-parallel) and does not misconsume its value", () => {
    expect(validateArgs(CHAT_SPEC, ["--max-parallel", "4", "hi"])).toEqual({
      unrecognized: [],
      typeError: null,
    });
  });

  it("rejects a flag the oracle's chat parser never declared (--temperature), the same as any unknown flag", () => {
    // Oracle: `chat --temperature 0.5 hi` -> unrecognized: --temperature hi
    expect(validateArgs(CHAT_SPEC, ["--temperature", "0.5", "hi"])).toEqual({
      unrecognized: ["--temperature", "hi"],
      typeError: null,
    });
  });

  it("raises a typeError for a non-integer value on an int-typed flag, without adding it to unrecognized", () => {
    const result = validateArgs(CHAT_SPEC, ["--max-iterations", "abc", "--no-input", "hi"]);
    expect(result.typeError).toEqual({ flag: "--max-iterations", value: "abc" });
    expect(result.unrecognized).toEqual([]);
  });

  it("recognizes --flag=value form for a known value-taking flag", () => {
    expect(validateArgs(MODELS_SPEC, ["--provider=bogus"])).toEqual({
      unrecognized: [],
      typeError: null,
    });
  });

  it("recognizes an unambiguous flag-name prefix (argparse allow_abbrev)", () => {
    expect(validateArgs(MODELS_SPEC, ["--prov", "bogus"])).toEqual({
      unrecognized: [],
      typeError: null,
    });
  });

  it("rejects an ambiguous prefix — and, like any unrecognized flag, does not consume the next token as its value", () => {
    const ambiguous = {
      flags: [
        { name: "--session", takesValue: true },
        { name: "--session-id", takesValue: true },
      ],
      positionalCount: 0,
    };
    expect(validateArgs(ambiguous, ["--sess", "x"]).unrecognized).toEqual(["--sess", "x"]);
  });
});

describe("chatTypeErrorMessage", () => {
  it("matches the oracle's byte-exact chat usage banner + error line", () => {
    expect(chatTypeErrorMessage("--max-iterations", "abc")).toBe(
      `${CHAT_USAGE_BANNER}lohra chat: error: argument --max-iterations: invalid int value: 'abc'\n`,
    );
  });
});

describe("runCli unrecognized-argument rejection (integration, byte-exact against a live oracle capture)", () => {
  it("doctor --frobnicate: rejects before running the report", async () => {
    const result = await invoke(["doctor", "--frobnicate"]);
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr: `${TOP_LEVEL_USAGE}lohra: error: unrecognized arguments: --frobnicate\n`,
    });
  });

  it("doctor --json --frobnicate: still zero stdout bytes under --json", async () => {
    const result = await invoke(["doctor", "--json", "--frobnicate"]);
    expect(result.stdout).toBe("");
    expect(result.code).toBe(2);
  });

  it("doctor bogus-positional: an extra positional is rejected the same way", async () => {
    const result = await invoke(["doctor", "bogus-positional"]);
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr: `${TOP_LEVEL_USAGE}lohra: error: unrecognized arguments: bogus-positional\n`,
    });
  });

  it("models --frobnicate: rejects instead of silently running the full report", async () => {
    const result = await invoke(["models", "--frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`${TOP_LEVEL_USAGE}lohra: error: unrecognized arguments: --frobnicate\n`);
  });

  it("tiers list --frobnicate, profile list --frobnicate, auth status --frobnicate, skill export use-lohra --frobnicate: all rejected", async () => {
    for (const argv of [
      ["tiers", "list", "--frobnicate"],
      ["profile", "list", "--frobnicate"],
      ["auth", "status", "--frobnicate"],
      ["skill", "export", "use-lohra", "--frobnicate"],
    ]) {
      const result = await invoke(argv);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(`${TOP_LEVEL_USAGE}lohra: error: unrecognized arguments: --frobnicate\n`);
    }
  });

  it("chat --frobnicate x --no-input --json oi: rejects instead of silently running with the wrong prompt", async () => {
    const result = await invoke(["chat", "--frobnicate", "x", "--no-input", "--json", "oi"]);
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr: `${TOP_LEVEL_USAGE}lohra: error: unrecognized arguments: --frobnicate oi\n`,
    });
  });

  it("chat --max-parallel 4 --no-input --json hi: a real, valid oracle flag no longer corrupts the prompt", async () => {
    const result = await invoke(["chat", "--max-parallel", "4", "--no-input", "--json", "hi"]);
    expect(result.code).toBe(2); // no provider configured — expected, unrelated to arg validation
    const envelope = JSON.parse(result.stdout) as { input: string };
    expect(envelope.input).toBe("hi");
  });

  it("chat --max-iterations abc --no-input --json hi: subcommand-specific invalid-int-value error, not the no-provider path", async () => {
    const result = await invoke(["chat", "--max-iterations", "abc", "--no-input", "--json", "hi"]);
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr:
        "usage: lohra chat [-h] [--profile PROFILE] [--no-input] [--model MODEL]\n" +
        "                  [--provider PROVIDER] [--session SESSION] [--no-tools]\n" +
        "                  [--yolo] [--json] [--max-parallel MAX_PARALLEL]\n" +
        "                  [--max-iterations MAX_ITERATIONS]\n" +
        "                  prompt\n" +
        "lohra chat: error: argument --max-iterations: invalid int value: 'abc'\n",
    });
  });

  it("chat --provider bogus --no-input --json hello: generic message in the envelope, detailed provider list on stderr", async () => {
    const result = await invoke(["chat", "--provider", "bogus", "--no-input", "--json", "hello"]);
    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stdout) as { error: string; input: string };
    expect(envelope.input).toBe("hello");
    expect(envelope.error).toBe(
      "no provider configured — run `lohra init` (or `lohra doctor`); details on stderr",
    );
    expect(result.stderr).toBe(
      "unknown provider 'bogus' (known: anthropic, deepseek, gemini, glm, groq, kimi, ollama, openai, openrouter, together, xai)\n",
    );
  });

  it("models --provider bogus stays the byte-exact control negative (already correct pre-fix)", async () => {
    const result = await invoke(["models", "--provider", "bogus"]);
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr: "error: unknown provider 'bogus' — run `lohra models` to see them all\n",
    });
  });
});
