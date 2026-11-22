import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

// Ordinary tmpdir fixtures are not private Windows destinations. Keep their
// real file round-trips with an explicit fake private-writer port; the Windows
// protection contract itself is exercised in windows-env-protection.test.ts.
vi.mock("../src/onboarding/env-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/onboarding/env-write.js")>();
  const { atomicWrite0600 } = await import("../src/auth/json-file.js");
  return {
    ...actual,
    upsertEnvFile: (
      path: string,
      updates: Readonly<Record<string, string>>,
      ops?: Parameters<typeof actual.upsertEnvFile>[2],
    ) => {
      if (process.platform !== "win32" || ops !== undefined)
        return actual.upsertEnvFile(path, updates, ops);
      const forbidden = () => {
        throw new Error("legacy .env writer used by Windows fixture");
      };
      return actual.upsertEnvFile(path, updates, {
        platform: "win32",
        privateWrite: (target, body) => {
          atomicWrite0600(target, body);
        },
        writeText: forbidden,
        chmod600: forbidden,
        replace: forbidden,
      });
    },
  };
});

import { TerminalInputError } from "../src/cli/terminal-io.js";
import { clientsFromLine, installSelectedClients } from "../src/onboarding/client-selection.js";
import {
  Prompter,
  evaluateOnboarding,
  markerPresent,
  runInit,
  shouldOfferWizard,
  writeMarker,
  type OnboardingSnapshot,
} from "../src/onboarding/wizard.js";
import type { InitProviderId } from "../src/onboarding/provider-selection.js";
import { listSkillClients, type SkillClient } from "../src/skills/clients.js";
import { readExportable } from "../src/skills/export.js";
import { ManagedInstallError, manageSkillInstallation } from "../src/skills/managed-install.js";
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
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
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
    expect(created).toEqual({
      code: 0,
      stdout: `created profile 'team_a' at ${join(base, "profiles", "team_a")}\n`,
      stderr: "",
    });
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

  it("treats blank injected answers and junk as the prompt default", async () => {
    let output = "";
    const empty = new Prompter(
      () => "",
      (text) => {
        output += text;
      },
    );
    expect(await empty.ask("provider", "anthropic")).toBe("anthropic");
    expect(await empty.confirm("configure?", false)).toBe(false);
    const junk = new Prompter(
      () => "maybe",
      () => undefined,
    );
    expect(await junk.confirm("configure?", true)).toBe(true);
    expect(output).toContain("provider [anthropic]: ");
  });

  it("does not persist a provider when the Anthropic key is skipped", async () => {
    const base = root();
    const home = join(base, "profile");
    let err = "";
    let out = "";
    const result = await runInit({
      snapshot: snapshot(home),
      base,
      home,
      codexHome: join(base, "codex"),
      environment: {},
      noInput: false,
      isTty: true,
      prompter: new Prompter(
        () => "",
        (text) => {
          err += text;
        },
      ),
      writeOut: (text) => {
        out += text;
      },
      chooseProviders: () => Promise.resolve(["anthropic"]),
      chooseDefault: () => Promise.reject(new Error("skipped key is not a default")),
      chooseClients: () => Promise.resolve([]),
    });
    expect(result).toBe(0);
    expect(existsSync(join(base, ".env"))).toBe(false);
    expect(existsSync(join(home, "auth.json"))).toBe(false);
    expect(markerPresent(home)).toBe(true);
    expect(out).toContain("not ready — no usable default was chosen.");
    expect(out).not.toContain("ready — provider anthropic");
    expect(err).toContain("ANTHROPIC_API_KEY (hidden, paste it, or Enter to skip) [skip]: ");
  });

  it("never prints a python line — the runtime does not embed or call Python (issue #696)", async () => {
    const base = root();
    const home = join(base, "profile");
    let out = "";
    const result = await runInit({
      snapshot: snapshot(home),
      base,
      home,
      codexHome: join(base, "codex"),
      environment: {},
      noInput: true,
      isTty: false,
      prompter: new Prompter(
        () => "",
        () => undefined,
      ),
      writeOut: (text) => {
        out += text;
      },
      chooseProviders: () => Promise.reject(new Error("read during read-only init")),
      chooseDefault: () => Promise.reject(new Error("read during read-only init")),
      chooseClients: () => Promise.resolve([]),
    });
    expect(result).toBe(0);
    expect(out.toLowerCase()).not.toContain("python");
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

function catalog(home: string): SkillClient[] {
  return listSkillClients({ HOME: home }, { platform: "linux", systemHome: home });
}

function clientNamed(clients: readonly SkillClient[], id: SkillClient["id"]): SkillClient {
  const client = clients.find((item) => item.id === id);
  if (!client) throw new Error(`missing ${id}`);
  return client;
}

describe("init client selection", () => {
  it("parses an injected client line and rejects an unknown client", () => {
    const clients = catalog("/fixture/user");
    expect(clientsFromLine(" Claude Code , pi ", clients).map((client) => client.id)).toEqual([
      "claude",
      "pi",
    ]);
    expect(clientsFromLine("  ", clients)).toEqual([]);
    expect(() => clientsFromLine("OpenRouter", clients)).toThrow("unknown skill client");
  });

  it("installs only the selected clients and leaves the others in place", () => {
    const home = root();
    const clients = catalog(home);
    const claude = clientNamed(clients, "claude");
    const codex = clientNamed(clients, "codex");
    manageSkillInstallation({ action: "add", skillsDirectory: claude.skillsDirectory });
    const preserved = readFileSync(
      join(claude.skillsDirectory, "use-lohra-ts", "SKILL.md"),
      "utf8",
    );
    const lines: string[] = [];
    expect(installSelectedClients([codex], (line) => lines.push(line))).toBe(0);
    expect(readFileSync(join(claude.skillsDirectory, "use-lohra-ts", "SKILL.md"), "utf8")).toBe(
      preserved,
    );
    expect(readFileSync(join(codex.skillsDirectory, "use-lohra-ts", "SKILL.md"), "utf8")).toBe(
      readExportable("use-lohra-ts"),
    );
    expect(lines.some((line) => line.startsWith("installed use-lohra-ts for Codex at"))).toBe(true);
    expect(lines.join("\n")).not.toContain("also discovers");
  });

  it("reports a conflict per client without a success marker and explains shared discovery", () => {
    const home = root();
    const clients = catalog(home);
    const claude = clientNamed(clients, "claude");
    const opencode = clientNamed(clients, "opencode");
    const pi = clientNamed(clients, "pi");
    const edited = join(opencode.skillsDirectory, "use-lohra-ts", "SKILL.md");
    mkdirSync(join(opencode.skillsDirectory, "use-lohra-ts"), { recursive: true });
    writeFileSync(edited, "local edit");
    const lines: string[] = [];
    expect(installSelectedClients([claude, opencode, pi], (line) => lines.push(line))).toBe(1);
    expect(readFileSync(edited, "utf8")).toBe("local edit");
    expect(existsSync(join(claude.skillsDirectory, "use-lohra-ts", "SKILL.md"))).toBe(true);
    expect(existsSync(join(pi.skillsDirectory, "use-lohra-ts", "SKILL.md"))).toBe(true);
    const failure = lines.find((line) => line.includes("OpenCode"));
    expect(failure).toContain(
      `failed to install use-lohra-ts for OpenCode at ${join(opencode.skillsDirectory, "use-lohra-ts")}`,
    );
    expect(failure).toContain("preserving");
    expect(failure).not.toContain("installed use-lohra-ts");
    expect(lines.some((line) => line.startsWith("installed use-lohra-ts for Claude Code"))).toBe(
      true,
    );
    const text = lines.join("\n");
    expect(text).toContain("OpenCode also discovers skills in");
    expect(text).toContain(join(home, ".claude", "skills"));
    expect(text).toContain(join(home, ".agents", "skills"));
    expect(text).toContain("Pi also discovers skills in");
    expect(text).not.toContain("Claude Code also discovers");
  });

  it("does not remove when nothing is selected and records a no-op update honestly", () => {
    const home = root();
    const codex = clientNamed(catalog(home), "codex");
    const lines: string[] = [];
    expect(installSelectedClients([], (line) => lines.push(line))).toBe(0);
    expect(lines.join("\n")).toContain("no clients selected");
    expect(lines.join("\n")).toContain("lohra skills remove");
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(installSelectedClients([codex], () => undefined)).toBe(0);
    const again: string[] = [];
    expect(installSelectedClients([codex], (line) => again.push(line))).toBe(0);
    expect(again.some((line) => line.includes("already up to date"))).toBe(true);
    expect(again.some((line) => line.startsWith("installed "))).toBe(false);
  });

  it("keeps going after one installer failure and never asks the installer to remove", () => {
    const home = root();
    const clients = catalog(home);
    const actions: string[] = [];
    const lines: string[] = [];
    const failures = installSelectedClients(
      [clientNamed(clients, "claude"), clientNamed(clients, "opencode")],
      (line) => lines.push(line),
      (request) => {
        actions.push(request.action);
        if (request.action === "remove") throw new Error("must not remove");
        if (request.skillsDirectory.includes("opencode")) {
          throw new ManagedInstallError("io", "disk full", new Error("fixture filesystem failure"));
        }
        return {
          status: "updated",
          directory: join(request.skillsDirectory, "use-lohra-ts"),
          preservedExtras: ["notes.txt"],
        };
      },
    );
    expect(failures).toBe(1);
    expect(actions).toEqual(["add", "add"]);
    expect(lines.some((line) => line.startsWith("updated use-lohra-ts for Claude Code"))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes("notes.txt"))).toBe(true);
    const failure = lines.find((line) => line.includes("failed to install"));
    expect(failure).toContain("OpenCode");
    expect(failure).toContain("disk full");
    expect(failure).toContain("fixture filesystem failure");
    expect(failure).not.toContain("installed use-lohra-ts");
    expect(failure).not.toContain("✓");
  });

  it("collects the selection before writing and installs only those destinations", async () => {
    const base = root();
    const home = join(base, "profile");
    const key = "fixture-anthropic-key-939";
    let sawSelection = false;
    const clients = catalog(base);
    const result = await runInit({
      snapshot: snapshot(home, {
        harnesses: [
          {
            name: "claude",
            home: join(base, "only-claude"),
            installed: true,
            homePresent: true,
          },
        ],
      }),
      base,
      home,
      codexHome: join(base, "codex"),
      environment: { HOME: base },
      noInput: false,
      isTty: true,
      prompter: new Prompter(
        () => key,
        (text) => {
          if (text.includes("export the use-lohra kit")) {
            throw new Error("legacy collective export is still offered");
          }
        },
      ),
      writeOut: (text) => {
        expect(text).not.toContain(key);
      },
      chooseProviders: () => {
        expect(existsSync(join(base, ".env"))).toBe(false);
        expect(existsSync(join(home, "auth.json"))).toBe(false);
        return Promise.resolve(["anthropic"]);
      },
      chooseDefault: (usable) => {
        expect(existsSync(join(base, ".env"))).toBe(false);
        expect(usable).toEqual(["anthropic"]);
        return Promise.resolve("anthropic");
      },
      chooseClients: (offered) => {
        expect(existsSync(join(base, ".env"))).toBe(false);
        expect(markerPresent(home)).toBe(false);
        expect(existsSync(join(home, "auth.json"))).toBe(false);
        expect(offered.map((client) => client.name)).toEqual([
          "Claude Code",
          "Codex",
          "OpenCode",
          "Pi",
        ]);
        sawSelection = true;
        return Promise.resolve(offered.filter((client) => client.id === "codex"));
      },
    });
    expect(sawSelection).toBe(true);
    expect(result).toBe(0);
    expect(readFileSync(join(base, ".env"), "utf8")).toBe(
      `ANTHROPIC_API_KEY=${key}\nLOHRA_PROVIDER=anthropic\n`,
    );
    expect(markerPresent(home)).toBe(true);
    expect(existsSync(join(base, ".agents", "skills", "use-lohra-ts", "SKILL.md"))).toBe(true);
    expect(existsSync(join(base, ".claude", "skills", "use-lohra-ts"))).toBe(false);
    expect(existsSync(join(base, "only-claude", "skills"))).toBe(false);
    expect(clients).toHaveLength(4);
  });

  it("stops before any write when selection is cancelled or names an unknown client", async () => {
    const base = root();
    const home = join(base, "profile");
    const common = {
      snapshot: snapshot(home),
      base,
      home,
      codexHome: join(base, "codex"),
      environment: { HOME: base },
      noInput: false,
      isTty: true,
      prompter: new Prompter(
        () => "fixture-anthropic-key-939",
        () => undefined,
      ),
      writeOut: () => undefined,
      chooseProviders: () => Promise.resolve(["anthropic"] as InitProviderId[]),
      chooseDefault: () => Promise.resolve("anthropic" as InitProviderId),
    };
    await expect(
      runInit({
        ...common,
        chooseDefault: () => {
          throw new TerminalInputError("terminal input ended (EOF); configuration interrupted");
        },
        chooseClients: () => Promise.resolve([]),
      }),
    ).rejects.toBeInstanceOf(TerminalInputError);
    expect(existsSync(join(base, ".env"))).toBe(false);
    expect(markerPresent(home)).toBe(false);
    expect(existsSync(join(base, ".claude"))).toBe(false);
    const forged = {
      ...clientNamed(catalog(base), "claude"),
      id: "nope",
    } as unknown as SkillClient;
    await expect(
      runInit({
        ...common,
        chooseClients: () => Promise.resolve([forged]),
      }),
    ).rejects.toThrow("unknown skill client");
    expect(existsSync(join(base, ".env"))).toBe(false);
  });

  it("stays read-only for --no-input and a non-TTY", async () => {
    for (const gate of [
      { noInput: true, isTty: true },
      { noInput: false, isTty: false },
    ]) {
      const base = root();
      let calls = 0;
      const result = await runInit({
        snapshot: snapshot(base),
        base,
        home: base,
        codexHome: join(base, "codex"),
        environment: { HOME: base },
        ...gate,
        prompter: new Prompter(
          () => {
            throw new Error("read during read-only init");
          },
          () => undefined,
        ),
        writeOut: () => undefined,
        chooseProviders: () => {
          calls += 1;
          return Promise.resolve([]);
        },
        chooseDefault: () => {
          calls += 1;
          return Promise.resolve("anthropic");
        },
        chooseClients: () => {
          calls += 1;
          return Promise.resolve([]);
        },
      });
      expect(result).toBe(0);
      expect(calls).toBe(0);
      expect(existsSync(join(base, ".env"))).toBe(false);
      expect(markerPresent(base)).toBe(false);
    }
  });
});
