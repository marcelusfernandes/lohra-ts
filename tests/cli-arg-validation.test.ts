import { describe, expect, it } from "vitest";

import {
  parseCommand,
  renderError,
  LEVELS,
  classifyUnknownCommand,
} from "../src/cli/arg-validation.js";
import {
  CHAT_SPEC,
  MODELS_SPEC,
  AUTH_SPEC,
  PROFILE_SPEC,
  TIERS_SPEC,
  SKILL_SPEC,
  SKILL_EXPORT_SPEC,
} from "../src/cli/arg-spec.js";
import { runCli, type CliIo } from "../src/cli.js";

// Every expected byte sequence below was captured [fio] against the real
// oracle CLI (backend/lohra/cli.py, argparse-based) in an isolated, hermetic
// HOME with `env -i`, not inferred from reading the Python source. The
// oracle never writes to stdout when rejecting arguments — even under
// --json — so every rejection assertion below pins stdout to "".

function invoke(
  argv: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    environment: { HOME: "/tmp/lohra-cli-arg-validation-unused", PATH: "/usr/bin:/bin" },
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    probeOllama: () => Promise.resolve(false),
  };
  return runCli(argv, io).then((code) => ({
    code,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
  }));
}

const TOP_LEVEL_USAGE =
  "usage: lohra [-h] [--version]\n" +
  "             {init,doctor,chat,dashboard,serve,cron,workflow,models,tiers,profile,auth,skill,update}\n" +
  "             ...\n";

const CHAT_USAGE =
  "usage: lohra chat [-h] [--profile PROFILE] [--no-input] [--model MODEL]\n" +
  "                  [--provider PROVIDER] [--session SESSION] [--no-tools]\n" +
  "                  [--yolo] [--json] [--max-parallel MAX_PARALLEL]\n" +
  "                  [--max-iterations MAX_ITERATIONS]\n" +
  "                  prompt\n";

describe("parseCommand — general mechanism (unit)", () => {
  it("(a) a `-`-prefixed token is never consumed as an option's value: unknown short flag becomes an extra, not a positional", () => {
    // Oracle: `chat -z --no-input --json oi` -> unrecognized arguments: -z
    const result = parseCommand(CHAT_SPEC, ["-z", "--no-input", "--json", "oi"]);
    expect(result.error).toBeNull();
    expect(result.extras).toEqual(["-z"]);
    expect(result.positionals).toEqual(["oi"]);
  });

  it("(a) a known value-flag whose next token looks like an option raises missingValue, not a bad consumption", () => {
    // Oracle: `chat --max-iterations --no-input --json oi` -> expected one argument
    const result = parseCommand(CHAT_SPEC, ["--max-iterations", "--no-input", "--json", "oi"]);
    expect(result.error).toEqual({ kind: "missingValue", flag: "--max-iterations" });
  });

  it("(b) an ambiguous flag prefix raises immediately, listing candidates in spec declaration order", () => {
    // Oracle: `chat --pro x --no-input --json` -> ambiguous option: --pro could match --profile, --provider
    const result = parseCommand(CHAT_SPEC, ["--pro", "x", "--no-input", "--json"]);
    expect(result.error).toEqual({
      kind: "ambiguous",
      token: "--pro",
      candidates: ["--profile", "--provider"],
    });
  });

  it("(b) an unambiguous flag prefix resolves to the canonical flag and consumes its value — closing the abbreviation-through-extraction gap", () => {
    // Oracle: `chat --sess x --no-input --json hi` -> session=x, prompt=hi
    const result = parseCommand(CHAT_SPEC, ["--sess", "x", "--no-input", "--json", "hi"]);
    expect(result.error).toBeNull();
    expect(result.options.get("--session")).toBe("x");
    expect(result.positionals).toEqual(["hi"]);
  });

  it("(b) a required positional left unfilled raises at this level, using this level's dest name", () => {
    // Oracle: `chat --no-input --json` (no prompt) -> the following arguments are required: prompt
    const result = parseCommand(CHAT_SPEC, ["--no-input", "--json"]);
    expect(result.error).toEqual({ kind: "requiredMissing", name: "prompt" });
  });

  it("(c) `--` ends option parsing: everything after it is positional, even if it looks like a flag", () => {
    // Oracle: `chat --no-input --json -- --frobnicate` -> executes, input: "--frobnicate"
    const result = parseCommand(CHAT_SPEC, ["--no-input", "--json", "--", "--frobnicate"]);
    expect(result.error).toBeNull();
    expect(result.extras).toEqual([]);
    expect(result.positionals).toEqual(["--frobnicate"]);
  });

  it("a boolean flag given =value is rejected (ignored explicit argument)", () => {
    // Oracle: `chat --json= --no-input oi` -> argument --json: ignored explicit argument ''
    const result = parseCommand(CHAT_SPEC, ["--json=", "--no-input", "oi"]);
    expect(result.error).toEqual({ kind: "unexpectedValue", flag: "--json", value: "" });
  });

  it("an invalid choice on a required positional raises immediately, distinct from requiredMissing", () => {
    // Oracle: `profile bogus` -> argument action: invalid choice: 'bogus' (choose from list, create)
    const result = parseCommand(PROFILE_SPEC, ["bogus"]);
    expect(result.error).toEqual({
      kind: "invalidChoice",
      name: "action",
      value: "bogus",
      choices: ["list", "create"],
    });
  });

  it("an optional positional never triggers requiredMissing, so trailing extras still bubble", () => {
    // Oracle: `profile create --xx` -> unrecognized arguments: --xx (NOT "usage of profile")
    const result = parseCommand(PROFILE_SPEC, ["create", "--xx"]);
    expect(result.error).toBeNull();
    expect(result.extras).toEqual(["--xx"]);
  });

  it("--flag=value form is recognized for a known value-taking flag", () => {
    expect(parseCommand(MODELS_SPEC, ["--provider=bogus"]).options.get("--provider")).toBe("bogus");
  });
});

describe("renderError", () => {
  it("chat invalidInt uses the chat-level usage banner and prefix", () => {
    expect(
      renderError({ kind: "invalidInt", flag: "--max-iterations", value: "abc" }, LEVELS.chat),
    ).toBe(`${CHAT_USAGE}lohra chat: error: argument --max-iterations: invalid int value: 'abc'\n`);
  });

  it("requiredMissing for tiers uses the tiers_cmd dest name and tiers-level usage", () => {
    expect(renderError({ kind: "requiredMissing", name: "tiers_cmd" }, LEVELS.tiers)).toBe(
      "usage: lohra tiers [-h] {list,suggest} ...\nlohra tiers: error: the following arguments are required: tiers_cmd\n",
    );
  });
});

describe("classifyUnknownCommand", () => {
  it("a solo unrecognized top-level token: every token is unrecognized, not an invalid choice", () => {
    // Oracle: `lohra --frobnicate` -> unrecognized arguments: --frobnicate
    expect(classifyUnknownCommand(["--frobnicate"])).toEqual({
      kind: "unrecognized",
      tokens: ["--frobnicate"],
    });
  });

  it("an option-like token followed by a non-option token: the non-option token is the invalid choice, not the flag", () => {
    // Oracle: `lohra --profile foo` -> invalid choice: 'foo' (NOT "unrecognized --profile")
    expect(classifyUnknownCommand(["--profile", "foo"])).toEqual({
      kind: "invalidChoice",
      value: "foo",
    });
  });

  it("multiple trailing tokens after an unmatched option: the first non-option token is the victim", () => {
    // Oracle: `lohra --frobnicate extra1 extra2` -> invalid choice: 'extra1'
    expect(classifyUnknownCommand(["--frobnicate", "extra1", "extra2"])).toEqual({
      kind: "invalidChoice",
      value: "extra1",
    });
  });
});

describe("runCli — byte-exact against live oracle captures", () => {
  const cases: readonly {
    readonly label: string;
    readonly argv: readonly string[];
    readonly code: number;
    readonly stderr: string;
  }[] = [
    {
      label: "C1: chat --max-iterations --no-input --json oi (next token looks like a flag)",
      argv: ["chat", "--max-iterations", "--no-input", "--json", "oi"],
      code: 2,
      stderr: `${CHAT_USAGE}lohra chat: error: argument --max-iterations: expected one argument\n`,
    },
    {
      label: "C1: chat -z --no-input --json oi (unknown short flag, not the prompt)",
      argv: ["chat", "-z", "--no-input", "--json", "oi"],
      code: 2,
      stderr: `${TOP_LEVEL_USAGE}lohra: error: unrecognized arguments: -z\n`,
    },
    {
      label: "C2: lohra --frobnicate (unrecognized, not invalid choice)",
      argv: ["--frobnicate"],
      code: 2,
      stderr: `${TOP_LEVEL_USAGE}lohra: error: unrecognized arguments: --frobnicate\n`,
    },
    {
      label: "C2: lohra --profile foo (invalid choice 'foo', not unrecognized --profile)",
      argv: ["--profile", "foo"],
      code: 2,
      stderr: `${TOP_LEVEL_USAGE}lohra: error: argument command: invalid choice: 'foo' (choose from init, doctor, chat, dashboard, serve, cron, workflow, models, tiers, profile, auth, skill, update)\n`,
    },
    {
      label: "C3: tiers --frobnicate (required tiers_cmd, tiers-level usage)",
      argv: ["tiers", "--frobnicate"],
      code: 2,
      stderr:
        "usage: lohra tiers [-h] {list,suggest} ...\nlohra tiers: error: the following arguments are required: tiers_cmd\n",
    },
    {
      label: "C3: tiers bogus (invalid choice, tiers-level usage)",
      argv: ["tiers", "bogus"],
      code: 2,
      stderr:
        "usage: lohra tiers [-h] {list,suggest} ...\nlohra tiers: error: argument tiers_cmd: invalid choice: 'bogus' (choose from list, suggest)\n",
    },
    {
      label: "C3: skill --frobnicate (required skill_cmd, skill-level usage)",
      argv: ["skill", "--frobnicate"],
      code: 2,
      stderr:
        "usage: lohra skill [-h] {export} ...\nlohra skill: error: the following arguments are required: skill_cmd\n",
    },
    {
      label: "C3: skill bogus (invalid choice, skill-level usage)",
      argv: ["skill", "bogus"],
      code: 2,
      stderr:
        "usage: lohra skill [-h] {export} ...\nlohra skill: error: argument skill_cmd: invalid choice: 'bogus' (choose from export)\n",
    },
    {
      label: "C3: profile --frobnicate (required action, profile-level usage)",
      argv: ["profile", "--frobnicate"],
      code: 2,
      stderr:
        "usage: lohra profile [-h] {list,create} [name]\nlohra profile: error: the following arguments are required: action\n",
    },
    {
      label: "C3: profile bogus (invalid choice, profile-level usage)",
      argv: ["profile", "bogus"],
      code: 2,
      stderr:
        "usage: lohra profile [-h] {list,create} [name]\nlohra profile: error: argument action: invalid choice: 'bogus' (choose from list, create)\n",
    },
    {
      label: "C3: auth --frobnicate (required action, auth-level usage)",
      argv: ["auth", "--frobnicate"],
      code: 2,
      stderr:
        "usage: lohra auth [-h] [--profile PROFILE] [--no-input] [--yes]\n                  {status,enable,disable,login,logout,prefer} [value]\nlohra auth: error: the following arguments are required: action\n",
    },
    {
      label: "C3: auth bogus (invalid choice, auth-level usage)",
      argv: ["auth", "bogus"],
      code: 2,
      stderr:
        "usage: lohra auth [-h] [--profile PROFILE] [--no-input] [--yes]\n                  {status,enable,disable,login,logout,prefer} [value]\nlohra auth: error: argument action: invalid choice: 'bogus' (choose from status, enable, disable, login, logout, prefer)\n",
    },
    {
      label: "C3: chat --pro x --no-input --json (ambiguous prefix, chat-level usage)",
      argv: ["chat", "--pro", "x", "--no-input", "--json"],
      code: 2,
      stderr: `${CHAT_USAGE}lohra chat: error: ambiguous option: --pro could match --profile, --provider\n`,
    },
    {
      label: "C3: doctor --profile (missing value, doctor-level usage and prefix — not top-level)",
      argv: ["doctor", "--profile"],
      code: 2,
      stderr:
        "usage: lohra doctor [-h] [--profile PROFILE] [--no-input] [--json]\nlohra doctor: error: argument --profile: expected one argument\n",
    },
    {
      label: "C5: chat --json= --no-input oi (boolean flag given =value)",
      argv: ["chat", "--json=", "--no-input", "oi"],
      code: 2,
      stderr: `${CHAT_USAGE}lohra chat: error: argument --json: ignored explicit argument ''\n`,
    },
    {
      label: "bare auth defaults nowhere: oracle requires an action too",
      argv: ["auth"],
      code: 2,
      stderr:
        "usage: lohra auth [-h] [--profile PROFILE] [--no-input] [--yes]\n                  {status,enable,disable,login,logout,prefer} [value]\nlohra auth: error: the following arguments are required: action\n",
    },
  ];

  for (const testCase of cases) {
    it(testCase.label, async () => {
      const result = await invoke(testCase.argv);
      expect(result.code).toBe(testCase.code);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(testCase.stderr);
    });
  }

  it("C4: chat --no-input --json -- --frobnicate executes with input '--frobnicate'", async () => {
    const result = await invoke(["chat", "--no-input", "--json", "--", "--frobnicate"]);
    expect(result.code).toBe(2); // no provider configured
    const envelope = JSON.parse(result.stdout) as { input: string };
    expect(envelope.input).toBe("--frobnicate");
  });

  it("doctor --frobnicate: still rejects before running the report (round-1 regression guard)", async () => {
    const result = await invoke(["doctor", "--frobnicate"]);
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr: `${TOP_LEVEL_USAGE}lohra: error: unrecognized arguments: --frobnicate\n`,
    });
  });

  it("chat --frobnicate x --no-input --json oi: still rejects instead of silently running with the wrong prompt (round-1 regression guard)", async () => {
    const result = await invoke(["chat", "--frobnicate", "x", "--no-input", "--json", "oi"]);
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr: `${TOP_LEVEL_USAGE}lohra: error: unrecognized arguments: --frobnicate oi\n`,
    });
  });

  it("chat --provider bogus --no-input --json hello: generic message in the envelope, detailed provider list on stderr (round-1 regression guard)", async () => {
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

  it("models --provider=bogus and --prov bogus now correctly reject (closes the previously-declared-open cell)", async () => {
    for (const argv of [
      ["models", "--provider=bogus"],
      ["models", "--prov", "bogus"],
    ]) {
      const result = await invoke(argv);
      expect(result).toEqual({
        code: 2,
        stdout: "",
        stderr: "error: unknown provider 'bogus' — run `lohra models` to see them all\n",
      });
    }
  });

  it("models --provider bogus stays the byte-exact control negative", async () => {
    const result = await invoke(["models", "--provider", "bogus"]);
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr: "error: unknown provider 'bogus' — run `lohra models` to see them all\n",
    });
  });

  it("chat --sess x --no-input --json hi: an unambiguous prefix resolves --session, not the prompt", async () => {
    const result = await invoke(["chat", "--sess", "x", "--no-input", "--json", "hi"]);
    expect(result.code).toBe(2); // no provider configured
    const envelope = JSON.parse(result.stdout) as { input: string };
    expect(envelope.input).toBe("hi");
  });

  it("chat --max-parallel 4 --no-input --json hi: a real, valid oracle flag no longer corrupts the prompt", async () => {
    const result = await invoke(["chat", "--max-parallel", "4", "--no-input", "--json", "hi"]);
    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stdout) as { input: string };
    expect(envelope.input).toBe("hi");
  });
});

describe("spec sanity — AUTH_SPEC / TIERS_SPEC / SKILL_SPEC dest names and choice order", () => {
  it("AUTH_SPEC's action choices match the oracle's declared order", () => {
    expect(AUTH_SPEC.positionals[0]).toEqual({
      name: "action",
      required: true,
      choices: ["status", "enable", "disable", "login", "logout", "prefer"],
    });
  });

  it("TIERS_SPEC and SKILL_SPEC model their sub-action as a required choice positional", () => {
    expect(TIERS_SPEC.positionals[0]).toEqual({
      name: "tiers_cmd",
      required: true,
      choices: ["list", "suggest"],
    });
    expect(SKILL_SPEC.positionals[0]).toEqual({
      name: "skill_cmd",
      required: true,
      choices: ["export"],
    });
  });

  it("SKILL_EXPORT_SPEC's name positional is required", () => {
    expect(SKILL_EXPORT_SPEC.positionals[0]).toEqual({ name: "name", required: true });
  });
});
