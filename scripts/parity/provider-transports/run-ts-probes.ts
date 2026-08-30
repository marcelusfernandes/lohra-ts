#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ClientPool } from "../../../src/agent/index.js";
import {
  ConversationRuntime,
  type ConversationRepository,
  type TurnCommit,
} from "../../../src/conversation/index.js";
import { getProviderProfile } from "../../../src/providers/index.js";
import {
  AnthropicMessagesTransport,
  type NormalizedResponse,
} from "../../../src/transports/index.js";
import { assertCredentialClean } from "../scrub.js";
import type { EvidenceRecord } from "../types.js";
import { canonicalJson } from "../canonical.js";

const root = resolve(import.meta.dirname, "../../..");
const evidenceRoot = resolve(root, ".probe-evidence/t10");
mkdirSync(evidenceRoot, { recursive: true });
const targetSha = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim();
const results: Record<string, unknown> = {};

const response = (overrides: Partial<NormalizedResponse> = {}): NormalizedResponse => ({
  content: "done",
  finishReason: "stop",
  toolCalls: [],
  reasoning: null,
  usage: {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  },
  providerData: null,
  ...overrides,
});

const runtimeSource = readFileSync(resolve(root, "src/conversation/runtime.ts"), "utf8");
const providerModelSource = readFileSync(
  resolve(root, "src/conversation/provider-model.ts"),
  "utf8",
);
const chatModelSource = readFileSync(
  resolve(root, "src/conversation/chat-completions-model.ts"),
  "utf8",
);
results["t10-runtime-single-loop-boundary"] = {
  runtimeLoops: (runtimeSource.match(/for \(let iteration/gu) ?? []).length,
  providerModelLoops: (providerModelSource.match(/for \(let iteration/gu) ?? []).length,
  chatModelLoops: (chatModelSource.match(/for \(let iteration/gu) ?? []).length,
  pass:
    (runtimeSource.match(/for \(let iteration/gu) ?? []).length === 1 &&
    !providerModelSource.includes("for (let iteration") &&
    !chatModelSource.includes("for (let iteration"),
};

const providerData = { thinking_blocks: [{ signature: "sig", thinking: "why", type: "thinking" }] };
let committed: TurnCommit | null = null;
const repository: ConversationRepository = {
  createSession() {},
  session() {
    return null;
  },
  loadMessages() {
    return [];
  },
  commitTurn(value: TurnCommit) {
    committed = structuredClone(value);
  },
  commitUsage() {},
  summary() {
    return null;
  },
};
const cloneRuntime = new ConversationRuntime({
  repository,
  transport: {
    complete() {
      return Promise.resolve(response({ providerData }));
    },
    close() {},
  },
  promptSnapshot: () => "p",
  idSource: () => "clone",
  clock: () => 1,
});
await cloneRuntime.runTurn({ input: "x", provider: "anthropic", model: "m", cwd: "/tmp" });
const providerBlock = providerData.thinking_blocks[0];
if (providerBlock === undefined) throw new Error("T10_PROVIDER_BLOCK_MISSING");
providerBlock.thinking = "mutated";
const committedText = JSON.stringify(committed);
results["t10-provider-data-readonly-deep-copy"] = {
  sourceMutated: providerBlock.thinking,
  committedPreserved: committedText.includes("why") && !committedText.includes("mutated"),
  pass: committedText.includes("why") && !committedText.includes("mutated"),
};

const schema = { type: "object", properties: { x: { type: "string" } } };
const built = new AnthropicMessagesTransport().buildKwargs({
  model: "m",
  messages: [],
  tools: [{ type: "function", function: { name: "x", parameters: schema } }],
});
schema.properties.x.type = "number";
const builtTools = built.tools as Array<{
  input_schema: { properties: { x: { type: string } } };
}>;
const builtTool = builtTools[0];
if (builtTool === undefined) throw new Error("T10_ANTHROPIC_TOOL_MISSING");
const copiedType = builtTool.input_schema.properties.x.type;
const aliasMutant = { input_schema: schema };
results["t10-anthropic-alias-mutant-killed"] = {
  productionType: copiedType,
  mutantType: aliasMutant.input_schema.properties.x.type,
  mutantKilled: copiedType === "string" && aliasMutant.input_schema.properties.x.type === "number",
  pass: copiedType === "string" && aliasMutant.input_schema.properties.x.type === "number",
};

const commits: TurnCommit[] = [];
const accountingRepository: ConversationRepository = {
  createSession() {},
  session() {
    return null;
  },
  loadMessages() {
    return [];
  },
  commitTurn(value: TurnCommit) {
    commits.push(structuredClone(value));
  },
  commitUsage() {
    throw new Error("ACCOUNTING_DOUBLE_COMMIT");
  },
  summary() {
    return null;
  },
};
const queued = [
  response({ content: "one", finishReason: "pause" }),
  response({
    content: null,
    finishReason: "tool_calls",
    toolCalls: [{ id: "c", name: "read_file", arguments: "{}", providerData: null }],
  }),
  response(),
];
let calls = 0;
const accountingRuntime = new ConversationRuntime({
  repository: accountingRepository,
  transport: {
    complete() {
      const next = queued[calls++];
      if (next === undefined) return Promise.reject(new Error("T10_RESPONSE_MISSING"));
      return Promise.resolve(next);
    },
    close() {},
  },
  toolDispatcher: {
    dispatch() {
      return Promise.resolve({ role: "tool", tool_call_id: "c", content: "ok" });
    },
  },
  promptSnapshot: () => "p",
  idSource: () => "accounting",
  clock: () => 1,
});
const accounting = await accountingRuntime.runTurn({
  input: "x",
  provider: "ollama",
  model: "m",
  cwd: "/tmp",
});
results["t10-accounting-no-double-count"] = {
  apiCalls: accounting.apiCalls,
  usage: accounting.usageTotal,
  commitCount: commits.length,
  committedApiCalls: commits[0]?.apiCalls,
  pass:
    accounting.apiCalls === 3 &&
    accounting.usageTotal?.inputTokens === 3 &&
    accounting.usageTotal.outputTokens === 6 &&
    commits.length === 1 &&
    commits[0]?.apiCalls === 3,
};

const parent = getProviderProfile("anthropic");
if (parent === null) throw new Error("T10_PARENT_PROFILE_MISSING");
let ownedCloses = 0;
let borrowedCloses = 0;
const pool = new ClientPool(
  parent,
  {
    close() {
      borrowedCloses += 1;
    },
  },
  {
    home: "/unused",
    environment: { OPENAI_API_KEY: "dummy" },
    build: () => ({
      close() {
        ownedCloses += 1;
      },
    }),
  },
);
await pool.get("openai");
await pool.close();
await pool.close();
results["t10-client-pool-close-idempotent"] = {
  ownedCloses,
  borrowedCloses,
  pass: ownedCloses === 1 && borrowedCloses === 0,
};

results["t10-reasoning-callback-publicly-absent"] = {
  runtimeHasCallback: runtimeSource.includes("onReasoning"),
  providerModelsHaveCallback: providerModelSource.includes("onReasoning"),
  pass: !runtimeSource.includes("onReasoning") && !providerModelSource.includes("onReasoning"),
};

const live = resolve(import.meta.dirname, "live-smoke.mjs");
const liveRuntime = mkdtempSync(join(tmpdir(), "lohra-t10-live-probe-"));
try {
  const liveRun = spawnSync(process.execPath, [live, "--transport", "chat_completions"], {
    cwd: liveRuntime,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: join(liveRuntime, "home"),
      TMPDIR: join(liveRuntime, "tmp"),
    },
    encoding: "utf8",
  });
  const livePath = join(liveRuntime, ".live-smoke-evidence/t10/chat_completions.json");
  const liveRecord = JSON.parse(readFileSync(livePath, "utf8")) as Record<string, unknown>;
  const expectedKeys = [
    "schemaVersion",
    "status",
    "transport",
    "provider",
    "model",
    "success",
    "exitCode",
    "responseType",
    "finishReason",
    "shape",
    "usage",
    "requestCount",
  ];
  results["t10-live-unavailable-closed-schema"] = {
    exitCode: liveRun.status,
    keys: Object.keys(liveRecord),
    status: liveRecord.status,
    requestCount: liveRecord.requestCount,
    pass:
      liveRun.status === 3 &&
      canonicalJson(Object.keys(liveRecord)) === canonicalJson(expectedKeys) &&
      liveRecord.status === "live-smoke-unavailable" &&
      liveRecord.requestCount === 0,
  };
} finally {
  rmSync(liveRuntime, { recursive: true, force: true });
}

const candidatePreload = readFileSync(
  resolve(import.meta.dirname, "candidate-preload.mjs"),
  "utf8",
);
const candidateDriver = readFileSync(resolve(import.meta.dirname, "candidate-probes.mjs"), "utf8");
results["t10-driver-no-canned-output"] = {
  preloadCreatesServer: candidatePreload.includes("createServer"),
  preloadContainsFixtureResponse: /ANTHROPIC-OK|CHAT-OK|CODEX-OK/u.test(candidatePreload),
  probeCreatesServer: candidateDriver.includes("createServer"),
  pass:
    !candidatePreload.includes("createServer") &&
    !/ANTHROPIC-OK|CHAT-OK|CODEX-OK/u.test(candidatePreload) &&
    !candidateDriver.includes("createServer"),
};

const thinking = new AnthropicMessagesTransport().normalizeResponse({
  content: [
    { type: "thinking", thinking: "r", signature: "s" },
    { type: "redacted_thinking", data: "d" },
  ],
});
const thinkingText = JSON.stringify(thinking.providerData);
const expectedThinking =
  '{"thinking_blocks":[{"signature":"s","thinking":"r","type":"thinking"},{"data":"d","type":"redacted_thinking"}]}';
const reorderedMutant: string =
  '{"thinking_blocks":[{"type":"thinking","signature":"s","thinking":"r"},{"type":"redacted_thinking","data":"d"}]}';
results["t10-thinking-key-order-mutant-killed"] = {
  actual: thinkingText,
  expected: expectedThinking,
  mutantDiffers: reorderedMutant !== expectedThinking,
  pass: thinkingText === expectedThinking && reorderedMutant !== expectedThinking,
};

const scrubRoot = mkdtempSync(join(tmpdir(), "lohra-t10-scrub-probe-"));
try {
  const operator = join(scrubRoot, "operator");
  mkdirSync(join(operator, ".codex"), { recursive: true });
  const classes = ["stdout", "stderr", "env", "headers", "body", "requestLog", "tree", "sqlite"];
  let caught = 0;
  let removed = 0;
  for (const captureClass of classes) {
    const marker = `T10-${captureClass}-CANARY-0123456789abcdef`;
    writeFileSync(join(operator, ".codex", "auth.json"), JSON.stringify({ access_token: marker }));
    const contaminated = join(scrubRoot, `${captureClass}.json`);
    const encoded = Buffer.from(captureClass === "stdout" ? marker : "").toString("base64");
    const evidence = {
      schemaVersion: 1,
      scenario: { id: captureClass, manifestSha256: "x" },
      commands: { oracle: { executable: "x", argv: [] }, candidate: { executable: "x", argv: [] } },
      capturePolicy: { tree: { enabled: true, root: "home", exclude: [] }, sqlite: [], events: [] },
      expectationPolicy: [],
      normalizationPolicy: [],
      preconditionPolicy: [],
      preconditions: [],
      runs: {
        oracle: {
          process: { exitCode: 0, signal: null, stdout: encoded, stderr: "" },
          tree: [],
          sqlite: {},
          events: {},
        },
        candidate: {
          process: { exitCode: 0, signal: null, stdout: "", stderr: "" },
          tree: [],
          sqlite: {},
          events: {},
        },
      },
      comparison: {
        verdict: "match",
        differences: [],
        normalized: { [captureClass]: { oracle: marker, candidate: null } },
      },
      expectations: { failures: [] },
      reproducibility: { excludedRawPointers: [], projectionSha256: "x" },
      verdict: "match",
    } as EvidenceRecord;
    writeFileSync(contaminated, JSON.stringify(evidence));
    try {
      assertCredentialClean(
        JSON.stringify(evidence),
        evidence,
        [],
        { fixtureTokens: false, operatorCredentials: true },
        operator,
      );
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Credential marker")) throw error;
      caught += 1;
      rmSync(contaminated, { force: true });
      if (!existsSync(contaminated)) removed += 1;
    }
  }
  results["t10-scrub-planted-canary"] = {
    classes,
    caught,
    removed,
    pass: caught === classes.length && removed === classes.length,
  };
} finally {
  rmSync(scrubRoot, { recursive: true, force: true });
}

const inventory = [
  "t10-runtime-single-loop-boundary",
  "t10-provider-data-readonly-deep-copy",
  "t10-anthropic-alias-mutant-killed",
  "t10-accounting-no-double-count",
  "t10-client-pool-close-idempotent",
  "t10-reasoning-callback-publicly-absent",
  "t10-live-unavailable-closed-schema",
  "t10-driver-no-canned-output",
  "t10-thinking-key-order-mutant-killed",
  "t10-scrub-planted-canary",
] as const;
let failures = 0;
const projections: Array<{ id: string; sha: string; pass: boolean }> = [];
for (const id of inventory) {
  const value = results[id] as Record<string, unknown>;
  const pass = value.pass === true;
  if (!pass) failures += 1;
  const projection = { id, layer: "probe-ts", value };
  const sha = createHash("sha256").update(canonicalJson(projection)).digest("hex");
  projections.push({ id, sha, pass });
  writeFileSync(
    join(evidenceRoot, `${id}.json`),
    `${JSON.stringify({ schemaVersion: 1, targetSha, ...projection, projectionSha256: sha }, null, 2)}\n`,
  );
}
const digest = createHash("sha256")
  .update(projections.map(({ id, sha }) => `${id}=${sha}\n`).join(""))
  .digest("hex");
process.stdout.write(
  `${JSON.stringify({ suite: "t10-provider-transports-ts-probes", probes: inventory.length, failures, digest, projections })}\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
