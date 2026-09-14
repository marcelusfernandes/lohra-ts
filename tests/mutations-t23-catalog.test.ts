// Pino do catálogo de `mutations:t23` (issue #293, fatia `context-window`).
// `context-window.ts` é um único arquivo (catálogo + runner, atrás da mesma
// guarda de entry-point dos outros seis — `ehEntryPoint`,
// `scripts/mutations/harness.ts`) porque o `Files` da issue só autoriza
// `scripts/mutations/context-window.ts` como script novo, ao contrário de
// `web-tools.ts`/`web-tools-mutants.ts` (runner e catálogo separados).
// Importar só `contextWindowMutants` aqui nunca dispara `main()`
// (`tests/mutations-runner-guard.test.ts` prova a guarda para os seis
// runners; este módulo segue o mesmo padrão). Este teste confere, num
// `npm test` normal e rápido, o que só apareceria em `npm run mutations:t23`
// (bem mais lento): os 19 mutantes existem, cada um mira um teste que já
// existe de fato, e cada `before` ocorre exatamente uma vez, ao pé da letra,
// no arquivo de `src/` mirado — mesmo padrão de
// `tests/mutations-t20-catalog.test.ts` (#152).
//
// Issue #519 (M16-S4, épico #490) acrescenta 2 mutantes ao caminho de abort
// em voo: p (`token-estimate.ts`'s `estimatePartialUsage` cobra
// `partial.text` no fator JSON, mais denso, em vez do fator de prosa) e q
// (`provider-model.ts`'s `AnthropicMessagesModel.complete` deixa de
// encaminhar `request.signal` no ramo streaming) — os dois vivem sob
// `src/conversation/**`/`src/context/**`, cobertos pelo `srcGlobs` desta
// fatia, não pelo de `supervision` (`src/workflow/**`, `src/orchestration/**`,
// `src/transports/**`): 15 + 2 = 17.
//
// Issue #569 (M16, épico #490, S5) acrescenta mais 2, os dois em
// `runtime.ts`: r (o conjunto `&& !signalAborted(signal)` que decide se uma
// chamada abortada é um steer-interrupt absorvível, removido) e s
// (`disarm?.()` no `finally` de cada chamada, removido): 17 + 2 = 19.
//
// Issue #587 (P11, compactação/título pelo AuxClient) acrescenta mais 4:
// t (`compaction.ts`'s `headAlignedKeepCount` perde o fallback seguro
// "manter nada"), u (`runtime.ts` para de derivar `maxTranscriptTokens` da
// janela real), v e w (`src/agent/aux.ts`'s `summarizeWithFallback` perde o
// catch, `auxTelemetry` para de contar chamadas) — `aux.ts` entra no
// `srcGlobs` desta fatia pela primeira vez: 19 + 4 = 23.
//
// Issue #620 (follow-up do veredito da PR #617) acrescenta x: `aux.ts`'s
// `summaryBudgetFor` volta ao `maxTokens` fixo em 1024 em vez de escalar com
// `summaryMaxTokens(estimateTokens(transcript))`, igual ao bug original que
// a issue corrige (o resumo pelo `AuxClient` truncava as seções verbatim que
// a #584 existe para preservar): 23 + 1 = 24.
//
// Issue #608 acrescenta y, mais um em `runtime.ts`: `runTurn` passa a anexar
// o overlay de avisos pendentes ao campo `system` do request (não só à
// mensagem do usuário) -- invariante 1 (prompt construído uma vez e
// congelado) quebra silenciosamente com um aviso pendente: 24 + 1 = 25.
//
// Issue #650 (item 13, veredito da PR #625) acrescenta z, o primeiro em
// `envelope.ts`: `errorEnvelope` para de somar `extra.auxUsage` a
// `usage_total` -- o mesmo gasto órfão que a issue corrige: 25 + 1 = 26.
//
// Issue #649 (sub-issue B1 de #637) acrescenta `aa`, o primeiro em
// `runtime-session.ts` (extraído de `runtime.ts:349-366`, que estava em
// 796/800 linhas): `resolveTurnSession` volta a substituir as faixas
// restauradas de uma sessão retomada por `promptSnapshot()` -- invariante 1
// quebra silenciosamente entre processos: 26 + 1 = 27.
//
// Issue #652 (sub-issue C2 de #637, veredito PR #635) acrescenta `ab` e
// `ac`, os dois primeiros em `notices-repository.ts` (`src/state/**`, já
// coberto pelo `srcGlobs` desta fatia por causa de `session-repository.ts`):
// `ab` (`list()` sem `scope` volta a ignorar `includeSessions`, reabrindo o
// vazamento de `session:*` para o modelo) e `ac` (`nullableRowReal` volta a
// `Number(value)`, um `acked_at` ilegível vira `NaN` em silêncio): 27 + 2 =
// 29.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { contextWindowMutants } from "../scripts/mutations/context-window.js";
import { contextPromptMutants } from "../scripts/mutations/context-prompt-mutants.js";

const root = resolve(__dirname, "..");

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function sourceOf(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("mutations:t23 catalog (compaction, estimator, context window)", () => {
  it("declara exatamente 29 mutantes", () => {
    expect(contextWindowMutants).toHaveLength(29);
  });

  it("cada id de mutante é único", () => {
    const ids = contextWindowMutants.map((mutant) => mutant.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("mira apenas compaction.ts (×5), runtime.ts (×6), token-estimate.ts (×3), context-window.ts (×2), windows-cache.ts (×2), session-repository.ts (×3), provider-model.ts (×1), aux.ts (×3), envelope.ts (×1), runtime-session.ts (×1), notices-repository.ts (×2)", () => {
    // Conta MUTANTES por arquivo (não edits) -- cada mutante deste catálogo
    // tem um único edit, então as duas contagens coincidem aqui, mas o
    // padrão (Set por mutante) segue mutations-t20-catalog.test.ts, que
    // precisa dele para mutantes com múltiplos edits no mesmo arquivo.
    const counts: Record<string, number> = {};
    for (const mutant of contextWindowMutants) {
      for (const file of new Set(mutant.edits.map((edit) => edit.file))) {
        counts[file] = (counts[file] ?? 0) + 1;
      }
    }
    expect(counts).toEqual({
      "src/conversation/compaction.ts": 5,
      "src/conversation/runtime.ts": 6,
      "src/context/token-estimate.ts": 3,
      "src/providers/context-window.ts": 2,
      "src/catalog/windows-cache.ts": 2,
      "src/state/session-repository.ts": 3,
      "src/conversation/provider-model.ts": 1,
      "src/agent/aux.ts": 3,
      "src/conversation/envelope.ts": 1,
      "src/conversation/runtime-session.ts": 1,
      "src/state/notices-repository.ts": 2,
    });
  });

  it("nenhum import do diretório histórico de paridade, nem npm run build", () => {
    const source = sourceOf("scripts/mutations/context-window.ts");
    expect(/from\s+["'][^"']*\/parity\//u.test(source)).toBe(false);
    expect(/npm run build/u.test(source)).toBe(false);
  });

  it('grep -rn "LOHRA_ORACLE_WORKSPACE|resolveOracleWorkspace" scripts/mutations/context-window.ts dá vazio', () => {
    const source = sourceOf("scripts/mutations/context-window.ts");
    expect(/LOHRA_ORACLE_WORKSPACE|resolveOracleWorkspace/u.test(source)).toBe(false);
  });

  for (const mutant of contextWindowMutants) {
    it(`${mutant.id}: cada "before" ocorre exatamente uma vez, verbatim, no arquivo mirado`, () => {
      for (const edit of mutant.edits) {
        expect(edit.before.length).toBeGreaterThan(0);
        expect(occurrences(sourceOf(edit.file), edit.before), `${mutant.id} @ ${edit.file}`).toBe(
          1,
        );
      }
    });

    it(`${mutant.id}: o foco existe em tests/ e o título do teste está lá, exatamente uma vez`, () => {
      expect(mutant.focus.file).toMatch(/^tests\/.*\.test\.ts$/);
      const testSource = sourceOf(mutant.focus.file);
      expect(
        occurrences(testSource, mutant.focus.test),
        `${mutant.id}: "${mutant.focus.test}" não ocorre exatamente uma vez em ${mutant.focus.file}`,
      ).toBe(1);
    });
  }
});

// Issue #646 (sub-issue A1 de #637): segundo catálogo da fatia
// `context-window` — doutrina, moldura de memória/perfil/instruções, nota
// de snapshot, git snapshot e as seções verbatim/truncamento de cauda do
// resumo. Mesmas checagens do catálogo acima, sobre `contextPromptMutants`.
describe("mutations:t23 catalog — context-prompt-mutants.ts (doctrine, prompt framing, git snapshot, summary verbatim)", () => {
  it("declara exatamente 16 mutantes", () => {
    expect(contextPromptMutants).toHaveLength(16);
  });

  it("cada id de mutante é único", () => {
    const ids = contextPromptMutants.map((mutant) => mutant.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("mira apenas doctrine.ts (×4), system-prompt.ts (×5), discovery.ts (×4), aux.ts (×2), compaction.ts (×1)", () => {
    const counts: Record<string, number> = {};
    for (const mutant of contextPromptMutants) {
      for (const file of new Set(mutant.edits.map((edit) => edit.file))) {
        counts[file] = (counts[file] ?? 0) + 1;
      }
    }
    expect(counts).toEqual({
      "src/context/doctrine.ts": 4,
      "src/context/system-prompt.ts": 5,
      "src/context/discovery.ts": 4,
      "src/agent/aux.ts": 2,
      "src/conversation/compaction.ts": 1,
    });
  });

  for (const mutant of contextPromptMutants) {
    it(`${mutant.id}: cada "before" ocorre exatamente uma vez, verbatim, no arquivo mirado`, () => {
      for (const edit of mutant.edits) {
        expect(edit.before.length).toBeGreaterThan(0);
        expect(occurrences(sourceOf(edit.file), edit.before), `${mutant.id} @ ${edit.file}`).toBe(
          1,
        );
      }
    });

    it(`${mutant.id}: o foco existe em tests/ e o título do teste está lá, exatamente uma vez`, () => {
      expect(mutant.focus.file).toMatch(/^tests\/.*\.test\.ts$/);
      const testSource = sourceOf(mutant.focus.file);
      expect(
        occurrences(testSource, mutant.focus.test),
        `${mutant.id}: "${mutant.focus.test}" não ocorre exatamente uma vez em ${mutant.focus.file}`,
      ).toBe(1);
    });
  }
});
