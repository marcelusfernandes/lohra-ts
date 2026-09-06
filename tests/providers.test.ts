import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { applyEnvFile, parseEnvText } from "../src/config/env-file.js";
import { getProviderProfile, listProviders } from "../src/providers/registry.js";
import { resolveProviderChoice, resolveProviderName } from "../src/providers/resolve.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const root = () => {
  const value = mkdtempSync(join(tmpdir(), "lohra-t04-test-"));
  roots.push(value);
  return value;
};
const down = () =>
  Promise.resolve({
    alive: false,
    detail: "ConnectError",
    models: [] as string[],
    url: "http://localhost:11434/api/tags",
  });
function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("expected object");
  return parsed as Record<string, unknown>;
}

describe("provider registry and resolution", () => {
  it("keeps the eleven-provider detection order and canonical aliases", () => {
    expect(listProviders().map((entry) => entry.name)).toEqual([
      "anthropic",
      "openai",
      "openrouter",
      "deepseek",
      "groq",
      "together",
      "gemini",
      "xai",
      "glm",
      "kimi",
      "ollama",
    ]);
    expect(getProviderProfile("ClAuDe")?.name).toBe("anthropic");
    expect(getProviderProfile("google")?.name).toBe("gemini");
    expect(getProviderProfile("zai")?.name).toBe("glm");
  });
  it("applies precedence and preserves whitespace-key asymmetry", () => {
    const env = { LOHRA_PROVIDER: " oai ", ANTHROPIC_API_KEY: "x", GROQ_API_KEY: "x" };
    expect(resolveProviderName(" google ", "or", env)).toBe("gemini");
    expect(resolveProviderName(" ", "or", env)).toBe("openrouter");
    expect(resolveProviderName(" ", " ", env)).toBe("openai");
    expect(resolveProviderName(null, null, { ANTHROPIC_API_KEY: "   ", OPENAI_API_KEY: "x" })).toBe(
      "anthropic",
    );
    expect(resolveProviderName(null, null, { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "x" })).toBe(
      "openai",
    );
  });
  it("only probes Ollama after auto resolution", async () => {
    let calls = 0;
    const probe = () => {
      calls++;
      return Promise.resolve({ alive: true, detail: "", models: ["m1", "m2"], url: "u" });
    };
    expect(
      await resolveProviderChoice({ environment: { OPENAI_API_KEY: "x" }, probeOllama: probe }),
    ).toMatchObject({ provider: "openai", origin: "api-key" });
    expect(calls).toBe(0);
    expect(await resolveProviderChoice({ environment: {}, probeOllama: probe })).toEqual({
      provider: "ollama",
      origin: "keyless",
      model: "m1",
      detail: "u",
    });
    expect(calls).toBe(1);
  });
  it("parses dotenv without overwriting real environment", () => {
    expect(parseEnvText("# x\nexport A='one'\nB=two=three\nBAD\nEMPTY=\n")).toEqual({
      A: "one",
      B: "two=three",
      EMPTY: "",
    });
    const home = root();
    const file = join(home, ".env");
    writeFileSync(file, "OPENAI_API_KEY=FILE\nGROQ_API_KEY=G\n");
    const env = { OPENAI_API_KEY: "REAL" };
    applyEnvFile(file, env);
    expect(env).toEqual({ OPENAI_API_KEY: "REAL", GROQ_API_KEY: "G" });
  });
});

describe("public provider commands", () => {
  async function invoke(args: string[], environment: Record<string, string>) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(args, {
      environment,
      stdout: (v) => stdout.push(v),
      stderr: (v) => stderr.push(v),
      probeOllama: down,
    });
    return { code, stdout: stdout.join(""), stderr: stderr.join("") };
  }
  it("matches the 1250-byte offline models JSON, UTF-8 direct in both JSON and text (issue #71)", async () => {
    const home = root();
    const json = await invoke(["models", "--json"], { HOME: home, PATH: "/usr/bin:/bin" });
    expect(json.code).toBe(0);
    expect(Buffer.byteLength(json.stdout)).toBe(1250);
    // docs/adr/0003-native-wire-format.md item 2: non-ASCII is emitted as
    // literal UTF-8 in JSON now too, no more \uXXXX escaping -- so the same
    // em dashes that show up in the human text also show up as raw UTF-8
    // bytes in the JSON payload (10 occurrences x 3 bytes each).
    expect([...Buffer.from(json.stdout)].filter((b) => b > 0x7f)).toHaveLength(30);
    expect(json.stdout).not.toContain("\\u");
    const text = await invoke(["models"], { HOME: home, PATH: "/usr/bin:/bin" });
    expect(text.code).toBe(0);
    expect([...Buffer.from(text.stdout)].filter((b) => b > 0x7f)).toHaveLength(63);
    expect(text.stdout).toContain("0 model(s) reachable across 11 provider(s)");
  });
  it("handles aliases, unknown providers, Codex opt-out and ignored provider env", async () => {
    const home = root();
    expect(
      parseObject(
        (await invoke(["models", "--provider", "ClAuDe", "--json"], { HOME: home })).stdout,
      ),
    ).toMatchObject({ providers: [expect.objectContaining({ provider: "anthropic" })] });
    const bad = await invoke(["models", "--provider", "bogus", "--json"], { HOME: home });
    expect(bad.code).toBe(2);
    const error = parseObject(bad.stdout).error;
    expect(typeof error).toBe("string");
    if (typeof error !== "string") throw new Error("expected error string");
    expect(error).toContain("unknown provider 'bogus'");
    expect(
      parseObject(
        (await invoke(["models", "--provider", "openai-codex", "--json"], { HOME: home })).stdout,
      ),
    ).toMatchObject({ providers: [expect.objectContaining({ source: "skipped" })] });
    const ignored = parseObject(
      (await invoke(["models", "--json"], { HOME: home, LOHRA_PROVIDER: "bogus" })).stdout,
    );
    const providers = ignored.providers;
    expect(Array.isArray(providers)).toBe(true);
    if (!Array.isArray(providers)) throw new Error("expected provider list");
    expect(providers).toHaveLength(11);
  });
  it("exercises whitespace key and invalid provider through doctor", async () => {
    const home = root();
    const good = await invoke(["doctor", "--json"], {
      HOME: home,
      PATH: "/usr/bin:/bin",
      ANTHROPIC_API_KEY: "   ",
      OPENAI_API_KEY: "x",
    });
    expect(good.code).toBe(0);
    expect(parseObject(good.stdout)).toMatchObject({
      environment: { detected_provider: "anthropic" },
    });
    const bad = await invoke(["doctor", "--json"], {
      HOME: home,
      PATH: "/usr/bin:/bin",
      LOHRA_PROVIDER: "bogus",
      OPENAI_API_KEY: "x",
    });
    expect(bad.code).toBe(2);
    expect(parseObject(bad.stdout)).toMatchObject({
      environment: { detected_provider: null, provider_origin: "none" },
    });
  });
  it("lists absent, valid and broken tiers read-only", async () => {
    const home = root();
    const base = join(home, ".lohra");
    mkdirSync(base, { recursive: true });
    expect((await invoke(["tiers", "list"], { HOME: home })).code).toBe(0);
    writeFileSync(
      join(base, "workflow_tiers.json"),
      JSON.stringify({
        small: { provider: "openai", model: "m", effort: "low" },
        big: { provider: "anthropic", model: "b" },
      }),
    );
    const valid = await invoke(["tiers", "list"], { HOME: home });
    expect(valid.stdout).toBe("small: openai/m/low\nbig: anthropic/b\n");
    writeFileSync(join(base, "workflow_tiers.json"), "[");
    expect((await invoke(["tiers", "list"], { HOME: home })).code).toBe(1);
    writeFileSync(join(base, "workflow_tiers.json"), JSON.stringify({ custom: { model: "m" } }));
    expect((await invoke(["tiers", "list"], { HOME: home })).code).toBe(1);
    writeFileSync(
      join(base, "workflow_tiers.json"),
      JSON.stringify({ custom: { model: "ignored" }, small: "shorthand-model" }),
    );
    expect((await invoke(["tiers", "list"], { HOME: home })).stdout).toBe(
      "small: shorthand-model\n",
    );
  });
});
