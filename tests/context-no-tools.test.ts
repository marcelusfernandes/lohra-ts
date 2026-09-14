// Issue #648 (grupo A, item 7b de #637): `--no-tools` (`chat.ts:314`
// `useTools`) removes the tool array from the request, but memory, user
// profile, and the skills index still reach the prompt (`chat.ts:353-360`) --
// only the TOOL that reads them (`memory`/`skill_view`) disappears, not the
// KNOWLEDGE. Veredito PR #611, non_blocking "AC2 sem teste — o glob EXISTE":
// this file did not exist before this issue. Same `runChat` + capturing HTTP
// server harness as `tests/chat-doctrine-tier.test.ts`; memory/profile
// seeded via `MemoryStore`'s own files, same pattern
// `tests/gateway/dashboard-prompt-contract.test.ts` uses for dashboard.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runChat } from "../src/commands/chat.js";
import { registerProvider } from "../src/providers/registry.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => {
      if (error === undefined) resolvePromise();
      else reject(error);
    });
  });
}

interface CapturedRequest {
  readonly messages: readonly Readonly<Record<string, unknown>>[];
  readonly tools?: unknown;
}

function startCapturingServer(captured: CapturedRequest[]): Server {
  return createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequest;
      captured.push(body);
      const payload = {
        id: "chatcmpl-t648-no-tools",
        object: "chat.completion",
        created: 0,
        model: "t648-no-tools-model",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      };
      const text = JSON.stringify(payload);
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(text)),
      });
      response.end(text);
    });
  });
}

function systemContentOf(captured: CapturedRequest): string {
  const system = captured.messages.find((message) => message.role === "system");
  return typeof system?.content === "string" ? system.content : "";
}

describe("chat.ts's --no-tools keeps memory/profile/skills knowledge in the prompt, only the tool disappears (issue #648, #637 item 7b)", () => {
  it("request sent has no tools array, but system carries <memory>, <user-profile>, and the skills index", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t648-no-tools-"));
    roots.push(root);
    const home = join(root, ".lohra");
    // MemoryStore reads <home>/memories/{MEMORY,USER}.md verbatim (src/memory/store.ts).
    mkdirSync(join(home, "memories"), { recursive: true });
    writeFileSync(join(home, "memories", "MEMORY.md"), "T648-NO-TOOLS-MEMORY-MARKER");
    writeFileSync(join(home, "memories", "USER.md"), "T648-NO-TOOLS-USER-PROFILE-MARKER");

    const captured: CapturedRequest[] = [];
    const server = startCapturingServer(captured);
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t648-no-tools-probe";
      registerProvider({
        name: provider,
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T648 no-tools probe",
        description: "Local in-memory composition-root probe (issue #648).",
        signupUrl: "",
        envVars: [],
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        modelsUrl: "",
        requiresApiKey: false,
        supportsVision: false,
        fallbackModels: ["t648-no-tools-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });

      const result = await runChat({
        input: "say hi",
        flags: new Map<string, string | true>([
          ["--provider", provider],
          ["--model", "t648-no-tools-model"],
          ["--json", true],
          ["--no-input", true],
          ["--no-tools", true],
        ]),
        environment: { HOME: root, PATH: process.env.PATH ?? "" },
        home,
        codexHome: join(root, ".codex"),
        cwd: root,
      });
      expect(result.code).toBe(0);
      expect(captured).toHaveLength(1);
      const body = captured[0] as CapturedRequest;

      // ChatCompletionsTransport.buildKwargs only sets `tools` when
      // `options.tools.length > 0` (src/transports/chat-completions.ts) --
      // `useTools === false` means the tool ARRAY that reaches the transport
      // is empty, so the key is omitted from the wire request entirely.
      expect(body.tools).toBeUndefined();

      const content = systemContentOf(body);
      expect(content).toContain("<memory>\nT648-NO-TOOLS-MEMORY-MARKER\n</memory>");
      expect(content).toContain(
        "<user-profile>\nT648-NO-TOOLS-USER-PROFILE-MARKER\n</user-profile>",
      );
      expect(content).toContain("workflow-authoring");
    } finally {
      await closeServer(server);
    }
  });

  it("WITHOUT --no-tools the same seeded memory/profile still reach the prompt AND a tools array is sent (control case)", async () => {
    const root = mkdtempSync(join(tmpdir(), "lohra-t648-with-tools-"));
    roots.push(root);
    const home = join(root, ".lohra");
    mkdirSync(join(home, "memories"), { recursive: true });
    writeFileSync(join(home, "memories", "MEMORY.md"), "T648-WITH-TOOLS-MEMORY-MARKER");

    const captured: CapturedRequest[] = [];
    const server = startCapturingServer(captured);
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test port");
      const provider = "t648-with-tools-probe";
      registerProvider({
        name: provider,
        apiMode: "chat_completions",
        aliases: [],
        displayName: "T648 with-tools probe",
        description: "Local in-memory composition-root probe (issue #648).",
        signupUrl: "",
        envVars: [],
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        modelsUrl: "",
        requiresApiKey: false,
        supportsVision: false,
        fallbackModels: ["t648-with-tools-model"],
        defaultMaxTokens: 256,
        defaultAuxModel: "",
      });

      const result = await runChat({
        input: "say hi",
        flags: new Map<string, string | true>([
          ["--provider", provider],
          ["--model", "t648-with-tools-model"],
          ["--json", true],
          ["--no-input", true],
        ]),
        environment: { HOME: root, PATH: process.env.PATH ?? "" },
        home,
        codexHome: join(root, ".codex"),
        cwd: root,
      });
      expect(result.code).toBe(0);
      expect(captured).toHaveLength(1);
      const body = captured[0] as CapturedRequest;
      expect(Array.isArray(body.tools)).toBe(true);
      expect((body.tools as readonly unknown[]).length).toBeGreaterThan(0);
      expect(systemContentOf(body)).toContain("<memory>\nT648-WITH-TOOLS-MEMORY-MARKER\n</memory>");
    } finally {
      await closeServer(server);
    }
  });
});
