#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const definitions = [
  ["anthropic-plain", "anthropic", "plain", ["--json", "--no-tools"]],
  [
    "anthropic-thinking-resume-process",
    "anthropic",
    "thinking-resume",
    ["--json", "--no-tools"],
    "resume",
  ],
  ["anthropic-tool-roundtrip", "anthropic", "tool", ["--json", "--yolo"]],
  ["anthropic-pause-three-requests", "anthropic", "pause", ["--json", "--no-tools"]],
  ["anthropic-max-tokens", "anthropic", "max", ["--json", "--no-tools"]],
  ["anthropic-refusal", "anthropic", "refusal", ["--json", "--no-tools"]],
  ["anthropic-stream-sse", "anthropic", "plain", ["--no-tools"]],
  ["anthropic-no-key-lifecycle", "anthropic", "no-key", ["--json", "--no-tools"]],
  ["codex-plain-headers", "codex", "plain", ["--json", "--no-tools"]],
  ["codex-tool-encrypted-replay", "codex", "tool-replay", ["--json", "--yolo"]],
  ["codex-failed-code", "codex", "failed", ["--json", "--no-tools"]],
  ["codex-default-model", "codex", "plain", ["--json", "--no-tools"], "default-model"],
  [
    "subscription-ignores-provider",
    "codex",
    "plain",
    ["--json", "--no-tools", "--provider", "anthropic"],
  ],
  ["chat-reasoning", "chat", "reasoning", ["--json", "--no-tools"]],
  ["chat-tool-raw-arguments", "chat", "tool", ["--json", "--yolo"]],
  ["chat-stream", "chat", "plain", ["--no-tools"]],
  ["openai-no-key-lifecycle", "chat", "no-key", ["--json", "--no-tools"]],
  ["three-transport-pack-smoke", "pack", "pack", []],
  [
    "chat-canonical-pause-max-iterations",
    "chat",
    "pause",
    ["--json", "--no-tools", "--max-iterations", "2"],
  ],
];

const output = resolve("scripts/parity/manifests/t10");
mkdirSync(output, { recursive: true });
for (const [name, transport, fixture, extra, mode = "single"] of definitions) {
  const provider = transport === "chat" ? "openai" : transport === "anthropic" ? "anthropic" : null;
  const argv = transport === "pack" ? [] : ["chat", `prompt-${name}`, ...extra];
  if (provider !== null && !argv.includes("--provider")) argv.push("--provider", provider);
  if (transport !== "pack" && mode !== "default-model")
    argv.push("--model", transport === "codex" ? "gpt-5.5" : "stub-model");
  writeFileSync(
    resolve(output, `t10-${name}.json`),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: `t10-${name}`,
        layer: "turno-publico",
        transport,
        fixture,
        mode,
        argv,
        expectedRequests:
          transport === "pack"
            ? 0
            : fixture === "no-key"
              ? 0
              : fixture === "pause"
                ? transport === "chat"
                  ? 2
                  : 3
                : fixture.includes("tool") || mode === "resume"
                  ? 2
                  : 1,
      },
      null,
      2,
    )}\n`,
  );
}
