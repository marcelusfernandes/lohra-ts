import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  Prompter,
  evaluateOnboarding,
  markerPresent,
  runInit,
  shouldOfferWizard,
  writeMarker,
  type OnboardingSnapshot,
} from "../src/onboarding/wizard.js";
import { formatValue, upsertEnvFile } from "../src/onboarding/env-write.js";
import { ensureHome, listProfiles, runProfile } from "../src/onboarding/profiles.js";

const root = (): string => mkdtempSync(join(tmpdir(), "lohra-onboarding-test-"));

function snapshot(base: string, overrides: Partial<OnboardingSnapshot> = {}): OnboardingSnapshot {
  return {
    activeProfile: null,
    authPreference: "auto",
    authRoute: "api_key",
    detectedProvider: null,
    envFile: join(base, ".env"),
    envFilePresent: false,
    harnesses: [],
    home: base,
    interactive: true,
    ollama: { alive: false, models: [], url: "http://localhost:11434/api/tags" },
    providerError: null,
    providerOrigin: "none",
    providerNames: ["anthropic", "openai", "ollama"],
    presentProviderVars: [],
    pythonSupported: true,
    pythonVersion: "3.12.10",
    subscriptionActive: false,
    ...overrides,
  };
}

describe(".env writer", () => {
  it("preserves unrelated lines, deduplicates, quotes like Python, and is idempotent", () => {
    const directory = root();
    const path = join(directory, ".env");
    writeFileSync(path, "# keep\nA=old\nOTHER=x\nexport A=last\n", "utf8");
    const first = upsertEnvFile(path, { A: "two words", B: "hash#value" });
    expect(first).toEqual(["A", "B"]);
    expect(readFileSync(path, "utf8")).toBe('# keep\nA="two words"\nOTHER=x\nB="hash#value"\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const before = statSync(path).mtimeMs;
    expect(upsertEnvFile(path, { A: "two words", B: "hash#value" })).toEqual([]);
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it("preserves the measured newline bug and exact quote choices", () => {
    expect(formatValue("plain")).toBe("plain");
    expect(formatValue("a b")).toBe('"a b"');
    expect(formatValue('a"b')).toBe("'a\"b'");
    expect(formatValue("a'\"b")).toBe("a'\"b");
    expect(formatValue("line\nbreak")).toBe("line\nbreak");
  });
});

describe("profiles", () => {
  it("creates the five isolated subdirectories and lists only directories", () => {
    const base = root();
    const home = join(base, "profiles", "team_a");
    ensureHome(home);
    expect(listProfiles(base)).toEqual(["team_a"]);
    expect(
      ["memories", "skills", "cron", "logs", "plugins"].every((name) =>
        existsSync(join(home, name)),
      ),
    ).toBe(true);
  });

  it("matches list/create outputs and keeps create idempotent", () => {
    const base = root();
    expect(runProfile("list", undefined, { base, activeProfile: null })).toEqual({
      code: 0,
      stdout: "no profiles yet — create one with `lohra profile create <name>`\n",
      stderr: "",
    });
    const created = runProfile("create", "team_a", { base, activeProfile: null });
    expect(created.stdout).toBe(`created profile 'team_a' at ${base}/profiles/team_a\n`);
    expect(runProfile("create", "team_a", { base, activeProfile: null })).toEqual(created);
    expect(runProfile("list", undefined, { base, activeProfile: "team_a" }).stdout).toBe(
      "* team_a\n",
    );
  });
});

describe("wizard", () => {
  it("uses nonblank LOHRA_NO_WIZARD and every absolute gate", () => {
    const directory = root();
    const base = snapshot(directory);
    expect(
      shouldOfferWizard({ snapshot: base, environment: {}, isStdinTty: true, isStderrTty: true }),
    ).toBe(true);
    for (const value of ["1", "0"])
      expect(
        shouldOfferWizard({
          snapshot: base,
          environment: { LOHRA_NO_WIZARD: value },
          isStdinTty: true,
          isStderrTty: true,
        }),
      ).toBe(false);
    for (const value of ["", "   "])
      expect(
        shouldOfferWizard({
          snapshot: base,
          environment: { LOHRA_NO_WIZARD: value },
          isStdinTty: true,
          isStderrTty: true,
        }),
      ).toBe(true);
    expect(
      shouldOfferWizard({
        snapshot: base,
        environment: {},
        jsonOutput: true,
        isStdinTty: true,
        isStderrTty: true,
      }),
    ).toBe(false);
    expect(
      shouldOfferWizard({
        snapshot: base,
        environment: {},
        noInput: true,
        isStdinTty: true,
        isStderrTty: true,
      }),
    ).toBe(false);
    expect(
      shouldOfferWizard({ snapshot: base, environment: {}, isStdinTty: false, isStderrTty: true }),
    ).toBe(false);
  });

  it("treats EOF and junk as the prompt default", () => {
    let output = "";
    const empty = new Prompter(
      () => "",
      (text) => {
        output += text;
      },
    );
    expect(empty.ask("provider", "anthropic")).toBe("anthropic");
    expect(empty.confirm("configure?", false)).toBe(false);
    const junk = new Prompter(
      () => "maybe",
      () => undefined,
    );
    expect(junk.confirm("configure?", true)).toBe(true);
    expect(output).toContain("provider [anthropic]: ");
  });

  it("writes a partial env and marker when credential input reaches EOF", () => {
    const base = root();
    const home = join(base, "profile");
    const answers = ["anthropic"];
    let err = "";
    let out = "";
    const environment: Record<string, string> = {};
    const result = runInit({
      snapshot: snapshot(home),
      base,
      home,
      environment,
      noInput: false,
      isTty: true,
      prompter: new Prompter(
        () => answers.shift() ?? "",
        (text) => {
          err += text;
        },
      ),
      writeOut: (text) => {
        out += text;
      },
    });
    expect(result).toBe(0);
    expect(readFileSync(join(base, ".env"), "utf8")).toBe("LOHRA_PROVIDER=anthropic\n");
    expect(markerPresent(home)).toBe(true);
    expect(out).toContain("provider anthropic is selected, but ANTHROPIC_API_KEY is not set.");
    expect(err).toContain("ANTHROPIC_API_KEY (paste it, or Enter to skip) [skip]: ");
  });

  it("writes marker directly and evaluates a configured provider", () => {
    const directory = root();
    const previous = process.umask(0);
    try {
      const path = writeMarker(directory);
      expect(readFileSync(path, "utf8")).toBe(
        "onboarding offered — re-run `lohra init` any time.\n",
      );
      expect(statSync(path).mode & 0o777).toBe(0o666);
    } finally {
      process.umask(previous);
    }
    expect(
      evaluateOnboarding(snapshot(directory), {
        LOHRA_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "dummy",
      }),
    ).toEqual([true, "ready — provider anthropic, model claude-opus-4-8."]);
  });
});
