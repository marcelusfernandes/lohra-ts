// Issue #650 (épico #637, grupo B, item 11; veredito da PR #617,
// non_blocking "addUsage duplicado"): prova que `addUsage` mora em UM lugar
// só (`src/conversation/usage.ts`), que `runtime.ts` não a exporta mais, e
// que `aux.ts` não carrega a cópia duplicada (`aux.ts:52-66` antes desta
// issue). RED na base: `usage.ts` não existe (import falha na coleta,
// `not implemented` do stub se o arquivo existir vazio) e `addUsage` ainda
// está em `runtime.ts`/`aux.ts`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { addUsage } from "../src/conversation/usage.js";
import * as runtimeModule from "../src/conversation/runtime.js";

const root = resolve(__dirname, "..");

function sourceOf(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

const usageA = {
  inputTokens: 11,
  outputTokens: 7,
  cacheReadTokens: 1,
  cacheWriteTokens: 2,
  reasoningTokens: 3,
};
const usageB = {
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 4,
  cacheWriteTokens: 5,
  reasoningTokens: 6,
};

describe("conversation/usage — addUsage módulo folha (issue #650)", () => {
  it("soma os cinco campos de Usage, sem mutar os operandos", () => {
    const frozenA = Object.freeze({ ...usageA });
    const frozenB = Object.freeze({ ...usageB });
    expect(addUsage(frozenA, frozenB)).toEqual({
      inputTokens: 111,
      outputTokens: 27,
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
      reasoningTokens: 9,
    });
  });

  it("null + null é null; null + Usage devolve uma CÓPIA de Usage", () => {
    expect(addUsage(null, null)).toBeNull();
    const copy = addUsage(null, usageA);
    expect(copy).toEqual(usageA);
    expect(copy).not.toBe(usageA);
  });

  it("Usage + null devolve o total intocado (mesma referência de valor)", () => {
    expect(addUsage(usageA, null)).toEqual(usageA);
  });

  it("runtime.ts não exporta mais addUsage (issue #650: módulo folha único)", () => {
    expect(Object.hasOwn(runtimeModule, "addUsage")).toBe(false);
  });

  it("aux.ts não carrega a cópia duplicada de addUsage (issue #650)", () => {
    const source = sourceOf("src/agent/aux.ts");
    expect(/function addUsage/u.test(source)).toBe(false);
  });

  it("envelope.ts importa addUsage de ./usage.js, não de ./runtime.js (issue #650)", () => {
    const source = sourceOf("src/conversation/envelope.ts");
    expect(source).toContain('from "./usage.js"');
    expect(source).not.toContain('addUsage } from "./runtime.js"');
  });
});
