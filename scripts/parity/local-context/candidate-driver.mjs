#!/usr/bin/env node
import { Buffer } from "node:buffer";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

import { MemoryFile, MemoryStore, parseMemory, renderMemory } from "../../../dist/memory/index.js";
import { loadSoul } from "../../../dist/memory/soul.js";
import {
  buildSystemPrompt,
  discoverInstructions,
  findProjectRoot,
  loadProjectContext,
} from "../../../dist/context/index.js";
import { SkillStore, renderSkillMd } from "../../../dist/skills/index.js";
import { applyEnvFile } from "../../../dist/config/env-file.js";
import {
  Prompter,
  evaluateOnboarding,
  markerPresent,
  runInit,
  shouldOfferWizard,
  writeMarker,
} from "../../../dist/onboarding/wizard.js";
import { formatValue, upsertEnvFile } from "../../../dist/onboarding/env-write.js";
import { runProfile } from "../../../dist/onboarding/profiles.js";
import { pythonJsonDumps } from "../../../dist/serialization/python-json.js";
import { runCli } from "../../../dist/cli.js";

const home = process.env.LOHRA_HOME;
const sandbox = join(process.env.HOME, "project");
mkdirSync(sandbox, { recursive: true });
const emit = (value) => process.stdout.write(`${pythonJsonDumps(value)}\n`);
const mode = (path) => (statSync(path).mode & 0o777).toString(8).padStart(4, "0");
const errorText = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error.message;
  }
};
const writeSkill = (root, name, description, body = "body", version = "1.0.0") => {
  const path = join(root, name, "SKILL.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderSkillMd(name, description, body, version), "utf8");
  return path;
};
const snapshot = (overrides = {}) => ({
  activeProfile: null,
  authPreference: "auto",
  authRoute: "api_key",
  detectedProvider: null,
  envFile: join(home, ".env"),
  envFilePresent: false,
  harnesses: [],
  home,
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
});

function memoryCore(mutant = false) {
  const path = join(home, "memories", "MEMORY.md");
  const file = new MemoryFile(path, 2200);
  const astral = "😀".repeat(1101);
  const boundary = mutant ? astral.length <= 2200 : Array.from(astral).length <= 2200;
  file.add("alpha");
  file.add("alpha");
  file.add("beta one");
  file.add("beta two");
  const ambiguous = errorText(() => file.replace("beta", "x"));
  const missing = errorText(() => file.remove("missing"));
  const before = readFileSync(path, "utf8");
  const over = errorText(() => new MemoryFile(path, 2200).add("x".repeat(2201)));
  emit({
    parse: [parseMemory("one§two"), parseMemory("cost is 50§ per unit"), parseMemory(" § ")],
    rendered: renderMemory(["one", "two"]),
    boundary,
    ambiguous,
    missing,
    over,
    unchanged: readFileSync(path, "utf8") === before,
  });
}

function memoryDiscipline() {
  const path = join(home, "memories", "MEMORY.md");
  const previous = process.umask(0);
  try {
    new MemoryFile(path, 2200).add("integral");
  } finally {
    process.umask(previous);
  }
  emit({
    content: readFileSync(path, "utf8"),
    mode: mode(path),
    temps: readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp")),
  });
}

function snapshotFreeze() {
  const store = new MemoryStore(home);
  store.memory.add("first");
  store.user.add("user-one");
  store.loadSnapshot();
  const first = store.snapshot();
  store.memory.add("second");
  const frozen = store.snapshot();
  const fresh = new MemoryStore(home);
  fresh.loadSnapshot();
  emit({ first, frozen, fresh: fresh.snapshot() });
}

function promptSnapshot() {
  const value = buildSystemPrompt({
    identity: "SOUL",
    environmentHints: { project_root: "/project", cwd: "/project/sub" },
    systemMessage: " system ",
    contextFiles: [["AGENTS.md", "rules"]],
    memorySnapshot: "memory",
    userProfile: "user",
    skillsIndex: "skills",
    today: "2030-01-02",
  });
  emit({
    stable: value.stable,
    context: value.context,
    volatile: value.volatile,
    text: value.text,
  });
}

function soul() {
  const values = [loadSoul(home) ?? null];
  writeFileSync(join(home, "SOUL.md"), "  persona  \n", "utf8");
  values.push(loadSoul(home));
  writeFileSync(join(home, "SOUL.md"), "   ", "utf8");
  values.push(loadSoul(home) ?? null);
  const other = join(home, "other");
  mkdirSync(join(other, "SOUL.md"), { recursive: true });
  emit({ values, directoryError: errorText(() => loadSoul(other)) !== null });
}

function projectDiscovery() {
  const root = join(sandbox, "repo");
  const leaf = join(root, "pkg", "sub");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(leaf, { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "outer agents", "utf8");
  writeFileSync(join(root, "CLAUDE.md"), "outer claude", "utf8");
  writeFileSync(join(root, "pkg", "AGENTS.md"), "near agents", "utf8");
  writeFileSync(join(root, "pkg", "pyproject.toml"), "", "utf8");
  emit({
    root: findProjectRoot(leaf),
    instructions: discoverInstructions(leaf),
    context: loadProjectContext(leaf),
  });
}

function projectBounds() {
  const root = join(sandbox, "bounds");
  let leaf = root;
  mkdirSync(join(root, ".git"), { recursive: true });
  for (let i = 0; i < 40; i++) leaf = join(leaf, `d${String(i).padStart(2, "0")}`);
  mkdirSync(leaf, { recursive: true });
  const far = findProjectRoot(leaf);
  const near = join(sandbox, "near", "one", "two");
  mkdirSync(join(sandbox, "near", ".git"), { recursive: true });
  mkdirSync(near, { recursive: true });
  const nonexistent = join(sandbox, "missing", "child");
  const missingContext = loadProjectContext(nonexistent);
  const longPath = `/${"x".repeat(5000)}`;
  const caught = loadProjectContext(longPath, () => {
    throw new Error("PATH_RESOLUTION_FAILED");
  });
  emit({
    farIsLeaf: far === realpathSync(leaf),
    nearFound: findProjectRoot(near) === realpathSync(join(sandbox, "near")),
    nonexistent: {
      instructions: missingContext.instructions,
      keys: Object.keys(missingContext.hints).sort(),
      cwdResolved: missingContext.hints.cwd === missingContext.hints.project_root,
    },
    caught: {
      instructions: caught.instructions,
      keys: Object.keys(caught.hints).sort(),
      received: caught.hints.cwd === longPath,
    },
  });
}

function instructionsUnsafe() {
  const root = join(sandbox, "unsafe");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "target"), "SECRET", "utf8");
  symlinkSync(join(root, "target"), join(root, "sub", "AGENTS.md"));
  mkdirSync(join(root, "sub", "CLAUDE.md"));
  emit({ instructions: discoverInstructions(join(root, "sub")) });
}

function skillsIndexEdge() {
  const project = join(sandbox, "project-skills");
  const builtin = join(sandbox, "builtin-skills");
  writeSkill(project, "shared-name", "project wins");
  writeSkill(join(home, "skills"), "shared-name", "home loses");
  writeSkill(join(home, "skills"), "home-only", "home desc");
  writeSkill(builtin, "b-skill", "builtin desc");
  const store = new SkillStore(home, [project], [builtin]);
  const index = store.index();
  const oversizedPath = join(project, "oversized", "SKILL.md");
  mkdirSync(dirname(oversizedPath), { recursive: true });
  const header = "---\nname: oversized\ndescription: x\nv: 1000\n---\n";
  writeFileSync(
    oversizedPath,
    `${header}${"x".repeat(257047 - Buffer.byteLength(header))}`,
    "utf8",
  );
  const skill = store.get("oversized");
  emit({
    index,
    oversized: {
      indexed: skill !== undefined,
      bodyLength: skill?.body.length ?? 0,
      marker: skill?.body.includes("truncated") ?? false,
    },
  });
}

function skillsMutations() {
  const project = join(sandbox, "project-skills");
  const builtin = join(sandbox, "builtin-skills");
  mkdirSync(project, { recursive: true });
  const builtinPath = writeSkill(builtin, "builtin-skill", "builtin", "original");
  const store = new SkillStore(home, [project], [builtin]);
  const created = store.create("project-new", "created", "body", "1.0.0", "project");
  const updated = store.update("builtin-skill", { body: "edited" });
  const builtinUnchanged = readFileSync(builtinPath, "utf8").includes("original");
  const deleted = store.delete("builtin-skill");
  emit({
    created: created.body,
    updated: updated.body,
    builtinUnchanged,
    deleted,
    winner: store.get("builtin-skill")?.body,
  });
}

function skillsValidation() {
  const store = new SkillStore(home);
  const valid = "a".repeat(64);
  store.create(valid, "ok", "body");
  const duplicate = errorText(() => store.create(valid, "ok", "body"));
  emit({
    valid: store.get(valid)?.name,
    invalid65: errorText(() => store.create("a".repeat(65), "x", "x")),
    invalidName: errorText(() => store.create("Bad_Name!", "x", "x")),
    longDescription: errorText(() => store.create("desc", "x".repeat(1025), "x")),
    duplicate,
    projectMissing: errorText(() => store.create("p", "x", "x", "1.0.0", "project")),
  });
}

function envUpsert() {
  const path = join(home, ".env");
  writeFileSync(path, "# keep\nA=old\nOTHER=x\nexport A=last\n", "utf8");
  const stages = [];
  const ops = {
    writeText(path, body) {
      writeFileSync(path, body, { encoding: "utf8", mode: 0o666 });
      stages.push(["write", mode(path)]);
    },
    chmod600(path) {
      chmodSync(path, 0o600);
      stages.push(["chmod", mode(path)]);
    },
    replace(source, destination) {
      renameSync(source, destination);
      stages.push(["replace", mode(destination)]);
    },
  };
  const previous = process.umask(0);
  let changed;
  try {
    changed = upsertEnvFile(path, { A: "two words", B: "line\nbreak" }, ops);
  } finally {
    process.umask(previous);
  }
  const content = readFileSync(path, "utf8");
  const second = upsertEnvFile(path, { A: "two words", B: "line" });
  emit({
    changed,
    content,
    second,
    formats: [formatValue("plain"), formatValue("a b"), formatValue('a"b'), formatValue("a'\"b")],
    mode: mode(path),
    stages,
  });
}

function envSameKey() {
  const path = join(home, ".env");
  writeFileSync(path, "SHARED=file\nONLY_FILE=yes\n", "utf8");
  const environment = { SHARED: "" };
  applyEnvFile(path, environment);
  const written = upsertEnvFile(path, { SHARED: "writer" });
  emit({ environment, written, file: readFileSync(path, "utf8") });
}

function wizardGates() {
  const base = snapshot();
  const rows = [];
  for (const value of [undefined, "", "   ", "0", "1"])
    rows.push({
      value: value ?? null,
      offered: shouldOfferWizard({
        snapshot: base,
        environment: value === undefined ? {} : { LOHRA_NO_WIZARD: value },
        isStdinTty: true,
        isStderrTty: true,
      }),
    });
  rows.push({
    value: "json",
    offered: shouldOfferWizard({
      snapshot: base,
      environment: {},
      jsonOutput: true,
      isStdinTty: true,
      isStderrTty: true,
    }),
  });
  rows.push({
    value: "pipe",
    offered: shouldOfferWizard({
      snapshot: base,
      environment: {},
      isStdinTty: false,
      isStderrTty: true,
    }),
  });
  rows.push({
    value: "configured",
    offered: shouldOfferWizard({
      snapshot: snapshot({ detectedProvider: "anthropic" }),
      environment: {},
      isStdinTty: true,
      isStderrTty: true,
    }),
  });
  emit(rows);
}

function wizardConfigure(eof = false) {
  const answers = eof ? ["anthropic"] : ["anthropic", "DUMMY-T06-KEY", "n"];
  let prompts = "";
  let output = "";
  const environment = {};
  const snap = snapshot({
    harnesses: [
      { name: "claude", home: join(home, "claude"), installed: true, homePresent: false },
    ],
  });
  const prompter = new Prompter(
    () => answers.shift() ?? "",
    (text) => {
      prompts += text;
    },
  );
  runInit({
    snapshot: snap,
    base: home,
    home,
    environment,
    noInput: false,
    isTty: true,
    prompter,
    writeOut: (text) => {
      output += text;
    },
  });
  const envText = readFileSync(join(home, ".env"), "utf8");
  emit({
    prompts,
    output,
    envKeys: envText
      .trim()
      .split("\n")
      .map((line) => line.split("=", 1)[0]),
    provider: environment.LOHRA_PROVIDER,
    keySet: Boolean(environment.ANTHROPIC_API_KEY),
    marker: readFileSync(join(home, ".initialized"), "utf8"),
    ready: evaluateOnboarding(snap, environment)[0],
  });
}

function profileErrors() {
  emit({
    missing: runProfile("create", undefined, { base: home, activeProfile: null }),
    invalid: runProfile("create", "../evil", { base: home, activeProfile: null }),
  });
}

function profileIsolation() {
  const roots = {
    default: home,
    p1: join(home, "profiles", "p1"),
    p2: join(home, "profiles", "p2"),
  };
  for (const [name, root] of Object.entries(roots)) {
    new MemoryStore(root).memory.add(`memory-${name}`);
    new SkillStore(root).create(`skill-${name}`, name, `body-${name}`);
    writeFileSync(join(root, "SOUL.md"), `soul-${name}`, "utf8");
    writeMarker(root);
  }
  const listed = runProfile("list", undefined, { base: home, activeProfile: "p1" });
  const values = Object.fromEntries(
    Object.entries(roots).map(([name, root]) => [
      name,
      {
        memory: new MemoryStore(root).memory.render(),
        skills: new SkillStore(root).scan().map((skill) => skill.name),
        soul: loadSoul(root),
        marker: markerPresent(root),
      },
    ]),
  );
  emit({ listed, values });
}

async function scopeShrink() {
  const invoke = async (argv) => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(argv, {
      environment: { ...process.env },
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
      isTty: false,
      probeOllama: async () => false,
    });
    return { code, stdout, stderr };
  };
  const implemented = {};
  implemented.init =
    (await invoke(["init", "--no-input"])).stderr.includes("not implemented") === false;
  implemented.profile =
    (await invoke(["profile", "list"])).stderr.includes("not implemented") === false;
  implemented.skill =
    (await invoke(["skill", "export", "no-such-kit"])).stderr.includes("not implemented") === false;
  const remaining = [];
  for (const command of ["dashboard", "cron", "workflow", "update"])
    if ((await invoke([command])).stderr.includes("not implemented in the TypeScript bootstrap"))
      remaining.push(command);
  const help = await invoke(["--help"]);
  emit({
    implemented,
    remaining,
    help13: [
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
    ].every((name) => help.stdout.includes(name)),
  });
}

async function skillExport() {
  const destination = join(process.env.HOME, "export");
  const invoke = async (argv) => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(argv, {
      environment: { ...process.env },
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
      isTty: false,
      probeOllama: async () => false,
    });
    return { code, stdout, stderr };
  };
  const missing = await invoke(["skill", "export", "no-such-kit", "--to", destination]);
  const written = await invoke(["skill", "export", "use-lohra", "--to", destination]);
  emit({ missing, written, assetBytes: statSync(join(destination, "use-lohra", "SKILL.md")).size });
}

const selected = process.argv[2];
if (selected === "memory-core") memoryCore();
else if (selected === "memory-utf16-mutant") memoryCore(true);
else if (selected === "memory-write-discipline") memoryDiscipline();
else if (selected === "snapshot-freeze") snapshotFreeze();
else if (selected === "prompt-snapshot") promptSnapshot();
else if (selected === "soul") soul();
else if (selected === "project-discovery") projectDiscovery();
else if (selected === "project-bounds") projectBounds();
else if (selected === "instructions-unsafe") instructionsUnsafe();
else if (selected === "skills-index-edge") skillsIndexEdge();
else if (selected === "skills-mutations") skillsMutations();
else if (selected === "skills-validation") skillsValidation();
else if (selected === "env-upsert") envUpsert();
else if (selected === "env-same-key") envSameKey();
else if (selected === "wizard-gates") wizardGates();
else if (selected === "wizard-configure") wizardConfigure(false);
else if (selected === "wizard-eof") wizardConfigure(true);
else if (selected === "profile-errors") profileErrors();
else if (selected === "profile-isolation") profileIsolation();
else if (selected === "scope-shrink") await scopeShrink();
else if (selected === "skill-export") await skillExport();
else throw new Error(`unknown local-context mode ${selected}`);
