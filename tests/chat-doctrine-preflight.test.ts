import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { runChat } from "../src/commands/chat.js";
import { registerProvider } from "../src/providers/registry.js";

it("rejects invalid doctrine before creating a state database", async () => {
  const root = mkdtempSync(join(tmpdir(), "lohra-doctrine-preflight-"));
  const home = join(root, ".lohra");
  const provider = `doctrine-preflight-${String(process.pid)}-${String(Math.random()).slice(2)}`;
  registerProvider({
    name: provider,
    apiMode: "chat_completions",
    aliases: [],
    displayName: "Doctrine preflight probe",
    description: "Local test provider that must never receive a request.",
    signupUrl: "",
    envVars: [],
    baseUrl: "http://127.0.0.1:9/v1",
    modelsUrl: "",
    requiresApiKey: false,
    supportsVision: false,
    fallbackModels: ["doctrine-preflight-model"],
    defaultMaxTokens: 256,
    defaultAuxModel: "",
  });
  try {
    await expect(
      runChat({
        input: "no turn should start",
        flags: new Map<string, string | true>([
          ["--provider", provider],
          ["--json", true],
          ["--no-input", true],
          ["--no-tools", true],
        ]),
        environment: {
          HOME: root,
          LOHRA_HOME: home,
          LOHRA_DOCTRINE: "loud",
          PATH: process.env.PATH ?? "",
        },
        home,
        codexHome: join(root, ".codex"),
        cwd: root,
      }),
    ).rejects.toThrow(/LOHRA_DOCTRINE.*loud/u);
    expect(existsSync(join(home, "state.db"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
