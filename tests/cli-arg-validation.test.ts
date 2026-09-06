import { describe, expect, it } from "vitest";

import {
  parseCommand,
  renderError,
  renderHelp,
  LEVELS,
  classifyUnknownCommand,
} from "../src/cli/arg-validation.js";
import {
  CHAT_SPEC,
  DOCTOR_SPEC,
  DASHBOARD_SPEC,
  SERVE_SPEC,
  MODELS_SPEC,
  AUTH_SPEC,
  CRON_SPEC,
  PROFILE_SPEC,
  TIERS_SPEC,
  TIERS_LIST_SPEC,
  TIERS_SUGGEST_SPEC,
  SKILL_SPEC,
  SKILL_EXPORT_SPEC,
  INIT_SPEC,
  UPDATE_SPEC,
  WORKFLOW_SPEC,
  WORKFLOW_LIST_SPEC,
  WORKFLOW_WATCH_SPEC,
  WORKFLOW_AUDIT_SPEC,
  FLAG_HELP,
} from "../src/cli/arg-spec.js";
import { runCli, type CliIo } from "../src/cli.js";

// Every expected error/behavior below exercises a specific parsing rule
// (what's an option, what's a value, what's a subcommand); the text each
// rule renders is this product's own (ADR 0003, "Human-facing text") and is
// not a byte contract with anything else. Comments marked "Scenario:"
// describe the shape of the input being tested, not any external program's
// output.

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

const TOP_LEVEL_USAGE = "usage: lohra <command> [options]\n";
const CHAT_USAGE = "usage: lohra chat [options]\n";

describe("parseCommand — general mechanism (unit)", () => {
  it("(a) a `-`-prefixed token is never consumed as an option's value: unknown short flag becomes an extra, not a positional", () => {
    // Scenario: `chat -z --no-input --json oi` -> -z is unrecognized, not the prompt
    const result = parseCommand(CHAT_SPEC, ["-z", "--no-input", "--json", "oi"]);
    expect(result.error).toBeNull();
    expect(result.extras).toEqual(["-z"]);
    expect(result.positionals).toEqual(["oi"]);
  });

  it("(a) a known value-flag whose next token looks like an option raises missingValue, not a bad consumption", () => {
    // Scenario: `chat --max-iterations --no-input --json oi` -> --max-iterations has no value
    const result = parseCommand(CHAT_SPEC, ["--max-iterations", "--no-input", "--json", "oi"]);
    expect(result.error).toEqual({ kind: "missingValue", flag: "--max-iterations" });
  });

  it("(b) an ambiguous flag prefix raises immediately, listing candidates in spec declaration order", () => {
    // Scenario: `chat --pro x --no-input --json` -> --pro matches both --profile and --provider
    const result = parseCommand(CHAT_SPEC, ["--pro", "x", "--no-input", "--json"]);
    expect(result.error).toEqual({
      kind: "ambiguous",
      token: "--pro",
      candidates: ["--profile", "--provider"],
    });
  });

  it("(b) an unambiguous flag prefix resolves to the canonical flag and consumes its value — closing the abbreviation-through-extraction gap", () => {
    // Scenario: `chat --sess x --no-input --json hi` -> session=x, prompt=hi
    const result = parseCommand(CHAT_SPEC, ["--sess", "x", "--no-input", "--json", "hi"]);
    expect(result.error).toBeNull();
    expect(result.options.get("--session")).toBe("x");
    expect(result.positionals).toEqual(["hi"]);
  });

  it("(b) a required positional left unfilled raises at this level, using this level's dest name", () => {
    // Scenario: `chat --no-input --json` (no prompt given)
    const result = parseCommand(CHAT_SPEC, ["--no-input", "--json"]);
    expect(result.error).toEqual({ kind: "requiredMissing", name: "prompt" });
  });

  it("(c) `--` ends option parsing: everything after it is positional, even if it looks like a flag", () => {
    // Scenario: `chat --no-input --json -- --frobnicate` -> input: "--frobnicate"
    const result = parseCommand(CHAT_SPEC, ["--no-input", "--json", "--", "--frobnicate"]);
    expect(result.error).toBeNull();
    expect(result.extras).toEqual([]);
    expect(result.positionals).toEqual(["--frobnicate"]);
  });

  it("a boolean flag given =value is rejected", () => {
    // Scenario: `chat --json= --no-input oi` -> --json takes no value
    const result = parseCommand(CHAT_SPEC, ["--json=", "--no-input", "oi"]);
    expect(result.error).toEqual({ kind: "unexpectedValue", flag: "--json", value: "" });
  });

  it("an invalid choice on a required positional raises immediately, distinct from requiredMissing", () => {
    // Scenario: `profile bogus` -> 'bogus' is not list|create
    const result = parseCommand(PROFILE_SPEC, ["bogus"]);
    expect(result.error).toEqual({
      kind: "invalidChoice",
      name: "action",
      value: "bogus",
      choices: ["list", "create"],
    });
  });

  it("an optional positional never triggers requiredMissing, so trailing extras still bubble", () => {
    // Scenario: `profile create --xx` -> --xx is unrecognized, not "usage of profile"
    const result = parseCommand(PROFILE_SPEC, ["create", "--xx"]);
    expect(result.error).toBeNull();
    expect(result.extras).toEqual(["--xx"]);
  });

  it("--flag=value form is recognized for a known value-taking flag", () => {
    expect(parseCommand(MODELS_SPEC, ["--provider=bogus"]).options.get("--provider")).toBe("bogus");
  });

  it("keeps Python non-finite float spellings for cron while workflow polling stays finite", () => {
    for (const value of ["nan", "inf", "-inf", "Infinity"]) {
      const cron = parseCommand(CRON_SPEC, ["add", `--at=${value}`]);
      expect(cron.error).toBeNull();
      expect(cron.options.get("--at")).toBe(value);
    }

    expect(parseCommand(WORKFLOW_WATCH_SPEC, ["run", "--poll", "NaN"]).error).toEqual({
      kind: "invalidFloat",
      flag: "--poll",
      value: "NaN",
    });
  });
});

describe("renderError — the usage banner + `lohra: error:` molde", () => {
  it("invalidInt: option name, level's own usage banner, and the offending value", () => {
    expect(
      renderError({ kind: "invalidInt", flag: "--max-iterations", value: "abc" }, LEVELS.chat),
    ).toBe(`${CHAT_USAGE}lohra: error: option --max-iterations expects an integer, got "abc"\n`);
  });

  it("requiredMissing for tiers uses the tiers_cmd dest name and tiers-level usage", () => {
    expect(renderError({ kind: "requiredMissing", name: "tiers_cmd" }, LEVELS.tiers)).toBe(
      "usage: lohra tiers [options]\nlohra: error: missing required argument: tiers_cmd\n",
    );
  });

  it("invalidChoice lists the offending value and the full choice set", () => {
    expect(
      renderError(
        { kind: "invalidChoice", name: "action", value: "bogus", choices: ["list", "create"] },
        LEVELS.profile,
      ),
    ).toBe(
      'usage: lohra profile [options]\nlohra: error: invalid value "bogus" for action; choose from list, create\n',
    );
  });
});

describe("classifyUnknownCommand", () => {
  it("a solo unrecognized top-level token: every token is unexpected, not an unknown command", () => {
    // Scenario: `lohra --frobnicate` -> no non-option-like token exists
    expect(classifyUnknownCommand(["--frobnicate"])).toEqual({
      kind: "unrecognized",
      tokens: ["--frobnicate"],
    });
  });

  it("an option-like token followed by a non-option token: the non-option token is the unknown command, not the flag", () => {
    // Scenario: `lohra --profile foo` -> "foo" is the attempted command name
    expect(classifyUnknownCommand(["--profile", "foo"])).toEqual({
      kind: "invalidChoice",
      value: "foo",
    });
  });

  it("multiple trailing tokens after an unmatched option: the first non-option token is the victim", () => {
    // Scenario: `lohra --frobnicate extra1 extra2` -> "extra1" is the attempted command name
    expect(classifyUnknownCommand(["--frobnicate", "extra1", "extra2"])).toEqual({
      kind: "invalidChoice",
      value: "extra1",
    });
  });
});

describe("runCli — the usage + `lohra: error:` molde, exit 2 (AC: one test per case)", () => {
  it("unknown command: `lohra nope`", async () => {
    const result = await invoke(["nope"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `${TOP_LEVEL_USAGE}lohra: error: unknown command "nope"; available commands: init, doctor, chat, dashboard, serve, cron, workflow, models, tiers, profile, auth, skill, update\n`,
    );
  });

  it("unknown option: `lohra doctor --frobnicate`", async () => {
    const result = await invoke(["doctor", "--frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `${TOP_LEVEL_USAGE}lohra: error: unexpected argument "--frobnicate"\n`,
    );
  });

  it("option without a value: `lohra chat --model` (no value)", async () => {
    const result = await invoke(["chat", "--model"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`${CHAT_USAGE}lohra: error: option --model needs a value\n`);
  });

  it("invalid value: `lohra cron --interval x`", async () => {
    const result = await invoke(["cron", "--interval", "x"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `usage: lohra cron [options]\nlohra: error: option --interval expects an integer, got "x"\n`,
    );
  });
});

describe("runCli — byte-exact against these captures", () => {
  const cases: readonly {
    readonly label: string;
    readonly argv: readonly string[];
    readonly code: number;
    readonly stderr: string;
  }[] = [
    {
      label: "chat --max-iterations --no-input --json oi (next token looks like a flag)",
      argv: ["chat", "--max-iterations", "--no-input", "--json", "oi"],
      code: 2,
      stderr: `${CHAT_USAGE}lohra: error: option --max-iterations needs a value\n`,
    },
    {
      label: "chat -z --no-input --json oi (unknown short flag, not the prompt)",
      argv: ["chat", "-z", "--no-input", "--json", "oi"],
      code: 2,
      stderr: `${TOP_LEVEL_USAGE}lohra: error: unexpected argument "-z"\n`,
    },
    {
      label: "lohra --frobnicate (unexpected, not unknown command)",
      argv: ["--frobnicate"],
      code: 2,
      stderr: `${TOP_LEVEL_USAGE}lohra: error: unexpected argument "--frobnicate"\n`,
    },
    {
      label: "lohra --profile foo (unknown command 'foo', not unexpected --profile)",
      argv: ["--profile", "foo"],
      code: 2,
      stderr: `${TOP_LEVEL_USAGE}lohra: error: unknown command "foo"; available commands: init, doctor, chat, dashboard, serve, cron, workflow, models, tiers, profile, auth, skill, update\n`,
    },
    {
      label: "tiers --frobnicate (required tiers_cmd, tiers-level usage)",
      argv: ["tiers", "--frobnicate"],
      code: 2,
      stderr: "usage: lohra tiers [options]\nlohra: error: missing required argument: tiers_cmd\n",
    },
    {
      label: "tiers bogus (invalid choice, tiers-level usage)",
      argv: ["tiers", "bogus"],
      code: 2,
      stderr:
        'usage: lohra tiers [options]\nlohra: error: invalid value "bogus" for tiers_cmd; choose from list, suggest\n',
    },
    {
      label: "skill --frobnicate (required skill_cmd, skill-level usage)",
      argv: ["skill", "--frobnicate"],
      code: 2,
      stderr: "usage: lohra skill [options]\nlohra: error: missing required argument: skill_cmd\n",
    },
    {
      label: "skill bogus (invalid choice, skill-level usage)",
      argv: ["skill", "bogus"],
      code: 2,
      stderr:
        'usage: lohra skill [options]\nlohra: error: invalid value "bogus" for skill_cmd; choose from export\n',
    },
    {
      label: "profile --frobnicate (required action, profile-level usage)",
      argv: ["profile", "--frobnicate"],
      code: 2,
      stderr: "usage: lohra profile [options]\nlohra: error: missing required argument: action\n",
    },
    {
      label: "profile bogus (invalid choice, profile-level usage)",
      argv: ["profile", "bogus"],
      code: 2,
      stderr:
        'usage: lohra profile [options]\nlohra: error: invalid value "bogus" for action; choose from list, create\n',
    },
    {
      label: "auth --frobnicate (required action, auth-level usage)",
      argv: ["auth", "--frobnicate"],
      code: 2,
      stderr: "usage: lohra auth [options]\nlohra: error: missing required argument: action\n",
    },
    {
      label: "auth bogus (invalid choice, auth-level usage)",
      argv: ["auth", "bogus"],
      code: 2,
      stderr:
        'usage: lohra auth [options]\nlohra: error: invalid value "bogus" for action; choose from status, enable, disable, login, logout, prefer\n',
    },
    {
      label: "chat --pro x --no-input --json (ambiguous prefix, chat-level usage)",
      argv: ["chat", "--pro", "x", "--no-input", "--json"],
      code: 2,
      stderr: `${CHAT_USAGE}lohra: error: option --pro is ambiguous; could match --profile, --provider\n`,
    },
    {
      label: "doctor --profile (missing value, doctor-level usage)",
      argv: ["doctor", "--profile"],
      code: 2,
      stderr: "usage: lohra doctor [options]\nlohra: error: option --profile needs a value\n",
    },
    {
      label: "chat --json= --no-input oi (boolean flag given =value)",
      argv: ["chat", "--json=", "--no-input", "oi"],
      code: 2,
      stderr: `${CHAT_USAGE}lohra: error: option --json does not take a value (got "")\n`,
    },
    {
      label: "bare auth defaults nowhere: an action is required too",
      argv: ["auth"],
      code: 2,
      stderr: "usage: lohra auth [options]\nlohra: error: missing required argument: action\n",
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

  it("chat --no-input --json -- --frobnicate executes with input '--frobnicate'", async () => {
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
      stderr: `${TOP_LEVEL_USAGE}lohra: error: unexpected argument "--frobnicate"\n`,
    });
  });

  it("chat --frobnicate x --no-input --json oi: still rejects instead of silently running with the wrong prompt (round-1 regression guard)", async () => {
    const result = await invoke(["chat", "--frobnicate", "x", "--no-input", "--json", "oi"]);
    expect(result).toEqual({
      code: 2,
      stdout: "",
      stderr: `${TOP_LEVEL_USAGE}lohra: error: unexpected arguments: "--frobnicate", "oi"\n`,
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

  it("chat --max-parallel 4 --no-input --json hi: a real, valid flag no longer corrupts the prompt", async () => {
    const result = await invoke(["chat", "--max-parallel", "4", "--no-input", "--json", "hi"]);
    expect(result.code).toBe(2);
    const envelope = JSON.parse(result.stdout) as { input: string };
    expect(envelope.input).toBe("hi");
  });
});

describe("--help — exit 0, lists options with a description (AC)", () => {
  it("lohra --help lists every top-level command", async () => {
    const result = await invoke(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("usage: lohra <command> [options]");
    for (const name of [
      "init",
      "doctor",
      "chat",
      "dashboard",
      "serve",
      "cron",
      "workflow",
      "models",
      "tiers",
      "profile",
      "auth",
      "skill",
      "update",
    ]) {
      expect(result.stdout).toMatch(new RegExp(`^\\s+${name}\\s+\\S`, "mu"));
    }
  });

  it("lohra chat --help lists its options with a description", async () => {
    const result = await invoke(["chat", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(CHAT_USAGE.trim());
    for (const flag of CHAT_SPEC.flags) {
      expect(result.stdout).toMatch(new RegExp(`^\\s+${flag.name}\\s+\\S`, "mu"));
    }
  });

  it("lohra tiers --help lists its sub-actions with a description", async () => {
    const result = await invoke(["tiers", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("usage: lohra tiers [options]");
    expect(result.stdout).toMatch(/^\s+list\s+\S/mu);
    expect(result.stdout).toMatch(/^\s+suggest\s+\S/mu);
  });
});

describe("renderHelp — throws rather than printing a blank description for an undeclared flag", () => {
  it("fails closed when a flag has no FLAG_HELP entry", () => {
    expect(() =>
      renderHelp(
        LEVELS.chat,
        { flags: [{ name: "--mystery", takesValue: false }], positionals: [] },
        "x",
      ),
    ).toThrow(/--mystery/);
  });
});

describe("FLAG_HELP — every declared flag has a non-empty description (fail-closed)", () => {
  const specs = [
    INIT_SPEC,
    DOCTOR_SPEC,
    CHAT_SPEC,
    DASHBOARD_SPEC,
    CRON_SPEC,
    SERVE_SPEC,
    MODELS_SPEC,
    TIERS_LIST_SPEC,
    TIERS_SUGGEST_SPEC,
    PROFILE_SPEC,
    AUTH_SPEC,
    SKILL_EXPORT_SPEC,
    WORKFLOW_SPEC,
    WORKFLOW_LIST_SPEC,
    WORKFLOW_WATCH_SPEC,
    WORKFLOW_AUDIT_SPEC,
    UPDATE_SPEC,
  ];
  const flagNames = new Set(specs.flatMap((spec) => spec.flags.map((flag) => flag.name)));

  for (const name of flagNames) {
    it(`has help text for ${name}`, () => {
      expect(FLAG_HELP[name]).toBeTruthy();
    });
  }
});

describe("spec sanity — AUTH_SPEC / TIERS_SPEC / SKILL_SPEC dest names and choice order", () => {
  it("AUTH_SPEC's action choices match the declared order", () => {
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
