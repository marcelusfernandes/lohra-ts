// Issue #149 (migração de mutations:t15 para scripts/mutations/): três dos
// 44 mutantes do catálogo de `mutations:t15`
// (`scripts/mutations/workflow-executor-mutants.ts`, extraído do runner na
// issue #186) editam fixtures que não são `src/**`
// (`t15-chat-workflow.json`, `candidate-chat.mjs`),
// realocadas para `scripts/mutations/fixtures/` para não depender de
// `scripts/parity/**` (que o #8 vai apagar). O runner original reprovava
// esses três mutantes através das mesmas asserções que
// `tests/parity/scenarios.test.ts` já faz contra os arquivos ORIGINAIS —
// arquivo que este teste deliberadamente não toca (também usado por t20,
// #151), então este é um arquivo NOVO e ADITIVO: a bateria focal de
// `workflow-executor.ts` roda os quatro arquivos legados de sempre MAIS
// este, para que mutar a cópia continue matando o mutante.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const manifestPath = "scripts/mutations/fixtures/t15-chat-workflow.json";
const candidatePath = "scripts/mutations/fixtures/candidate-chat.mjs";

interface T15Policy {
  readonly comparisons: readonly { readonly class: string; readonly field: string }[];
  readonly normalizations: readonly {
    readonly field: string;
    readonly kind: string;
    readonly pattern?: string;
  }[];
}

describe("scripts/mutations/fixtures/t15-chat-workflow.json", () => {
  it("compara events.requests com uma normalização de run-id não hash-only (mata chat-run-id-normalization-removed)", () => {
    const policy = JSON.parse(readFileSync(resolve(manifestPath), "utf8")) as T15Policy;
    const rule = policy.normalizations.find((entry) => entry.field === "events.requests");
    expect(rule).toMatchObject({ kind: "replace-regex" });
    expect(rule?.pattern).toContain('"run_id"');
  });

  it("mantém events.requests no conjunto real de comparação (mata chat-requests-comparison-removed)", () => {
    const policy = JSON.parse(readFileSync(resolve(manifestPath), "utf8")) as T15Policy;
    expect(policy.comparisons).toContainEqual({ class: "stub", field: "events.requests" });
  });
});

describe("scripts/mutations/fixtures/candidate-chat.mjs", () => {
  it("compõe o prompt do sistema com o builder real do produto (mata chat-prompt-composition-removed)", () => {
    const source = readFileSync(resolve(candidatePath), "utf8");
    expect(source).toContain('buildSystemPrompt({ systemMessage: "T15 canned workflow chat" })');
    expect(source).not.toContain('promptSnapshot: () => "T15 canned workflow chat"');
  });
});
