// Catálogo + runner de mutação da fatia `context-window` (issue #293):
// compactação preflight (`src/conversation/compaction.ts`, `runtime.ts`),
// estimador de tokens (`src/context/token-estimate.ts`), resolução da
// janela de contexto (`src/providers/context-window.ts`), cache de janelas
// por catálogo (`src/catalog/windows-cache.ts`) e a escrita atômica de
// `compactHistory` (`src/state/session-repository.ts`). Achado do `qa`
// pós-merge da PR #284 (epic #230, "janela de contexto"): nenhum desses
// arquivos tinha mutante nos 173 do catálogo até aqui.
//
// Um único arquivo (não runner + catálogo separados como `web-tools.ts` /
// `web-tools-mutants.ts`) porque o `Files` da issue #293 só autoriza
// `scripts/mutations/context-window.ts` como script novo — os 15 mutantes
// são dado puro (`export const contextWindowMutants`, descoberto por
// conteúdo por `tests/mutations-slices.test.ts`) e o runner abaixo mora no
// mesmo módulo, atrás da mesma guarda de entry-point que os outros seis
// (`ehEntryPoint`, `scripts/mutations/harness.ts`, issue #186) — importar
// este módulo (como `tests/mutations-t23-catalog.test.ts` e
// `tests/mutations-slices.test.ts` fazem) nunca dispara `main()`.
//
// Mecânica A (git archive do HEAD + vitest focado), igual a `web-tools.ts`:
// baseline verde por foco -> mutante vermelho nesse foco -> restore verde.
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

import {
  applyEditExactlyOnce,
  classify,
  ehEntryPoint,
  prepareArchiveSandbox,
  restoreAll,
  runFocusedVitest,
  snapshotFiles,
  writeReport,
} from "./harness.js";
import type { Focus, Mutant, MutationReport } from "./types.js";

const compaction = "src/conversation/compaction.ts";
const runtime = "src/conversation/runtime.ts";
const tokenEstimate = "src/context/token-estimate.ts";
const contextWindow = "src/providers/context-window.ts";
const windowsCache = "src/catalog/windows-cache.ts";
const sessionRepository = "src/state/session-repository.ts";

const compactionTests = "tests/conversation-compaction.test.ts";
const runtimeTests = "tests/conversation-runtime.test.ts";
const tokenEstimateTests = "tests/context-estimate.test.ts";
const contextWindowTests = "tests/providers-context-window.test.ts";
const catalogPricingTests = "tests/catalog-pricing.test.ts";
const stateLocksTests = "tests/state-locks.test.ts";
const providerModel = "src/conversation/provider-model.ts";
const abortInFlightTests = "tests/transports-abort-in-flight.test.ts";

export const contextWindowMutants: readonly Mutant[] = [
  {
    id: "a-threshold-margin-sign-flipped",
    category: "compaction",
    mechanism:
      "compactionThreshold soma maxTokens à janela em vez de reservá-lo — o teto de compactação fica maior que a janela real em vez de menor",
    focus: { file: compactionTests, test: "subtracts maxTokens beyond the margin" },
    edits: [
      {
        file: compaction,
        before: "  return input.window - Math.max(0, input.maxTokens) - margin;\n",
        after: "  return input.window + Math.max(0, input.maxTokens) - margin;\n",
      },
    ],
  },
  {
    id: "b-threshold-ratio-never-conservative",
    category: "compaction",
    mechanism:
      "compactionThreshold para de distinguir source 'provider'/'default' (estimativa) de 'table' (medição) — todo source usa a mesma reserva menor, BASE_RESERVE_RATIO",
    focus: {
      file: compactionTests,
      test: "reserves more of the window when the source is an estimate, not a measurement",
    },
    edits: [
      {
        file: compaction,
        before: '    input.source === "provider" || input.source === "default"\n',
        after: "    false\n",
      },
    ],
  },
  {
    id: "c-conservative-reserve-ratio-zeroed",
    category: "compaction",
    mechanism:
      "CONSERVATIVE_RESERVE_RATIO vira 0 — uma janela cuja fonte é 'provider'/'default' (nunca medida pelo próprio provedor) para de reservar margem nenhuma",
    focus: {
      file: compactionTests,
      test: "reserves more of the window when the source is an estimate, not a measurement",
    },
    edits: [
      {
        file: compaction,
        before: "export const CONSERVATIVE_RESERVE_RATIO = 0.15;\n",
        after: "export const CONSERVATIVE_RESERVE_RATIO = 0;\n",
      },
    ],
  },
  {
    id: "d-tail-cut-boundary-role-flipped",
    category: "compaction",
    mechanism:
      "turnAlignedTailCount procura o limite mais próximo em 'assistant' em vez de 'user' — o corte deixa de alinhar com o início do turno, podendo separar um tool_calls dos seus tool results",
    focus: {
      file: compactionTests,
      test: "keeps at least minKeep messages, landing on the nearest user boundary",
    },
    edits: [
      {
        file: compaction,
        before: '    if (messages[cut]?.role === "user") return messages.length - cut;\n',
        after: '    if (messages[cut]?.role === "assistant") return messages.length - cut;\n',
      },
    ],
  },
  {
    id: "e-compaction-latch-removed",
    category: "runtime",
    mechanism:
      "preflightCompact para de checar compactedThisTurn — uma segunda compactação no mesmo turno deixa de ser recusada com ContextWindowExceededError",
    focus: {
      file: runtimeTests,
      test: "never compacts twice in the same turn — a second overflow is refused with a named fault",
    },
    edits: [
      {
        file: runtime,
        before: "    if (context.compactedThisTurn) {\n",
        after: "    if (false && context.compactedThisTurn) {\n",
      },
    ],
  },
  {
    id: "f-fail-open-return-removed",
    category: "runtime",
    mechanism:
      "preflightCompact continua a execução depois de emitir 'compaction.unsupported' em vez de retornar null — um repository sem capacidade de compactação deixa de ser fail-open e passa a lançar CompactionUnsupportedError",
    focus: {
      file: runtimeTests,
      test: "fails open",
    },
    edits: [
      {
        file: runtime,
        before:
          '      context.emit("compaction.unsupported", "COMPACTION_UNSUPPORTED");\n      return null;\n    }\n',
        after: '      context.emit("compaction.unsupported", "COMPACTION_UNSUPPORTED");\n    }\n',
      },
    ],
  },
  {
    id: "g-estimate-tokens-tool-result-ignored",
    category: "estimate",
    mechanism:
      "contentTokens zera o conteúdo de uma mensagem role:'tool' em vez de cobrá-lo pelo fator JSON — um resultado de tool inteiro deixa de contar tokens",
    focus: { file: tokenEstimateTests, test: "pins the exact token count for a tool result" },
    edits: [
      {
        file: tokenEstimate,
        before:
          '    const factor = role === "tool" ? JSON_CHARS_PER_TOKEN : TEXT_CHARS_PER_TOKEN;\n    return charsToTokens(content.length, factor);\n',
        after:
          '    if (role === "tool") return 0;\n    return charsToTokens(content.length, TEXT_CHARS_PER_TOKEN);\n',
      },
    ],
  },
  {
    id: "h-estimate-tokens-message-overhead-zeroed",
    category: "estimate",
    mechanism:
      "MESSAGE_OVERHEAD_TOKENS vira 0 — o overhead fixo por mensagem (formatação de role, delimitadores) para de ser cobrado",
    focus: {
      file: tokenEstimateTests,
      test: "pins the exact token count for a short user message",
    },
    edits: [
      {
        file: tokenEstimate,
        before: "const MESSAGE_OVERHEAD_TOKENS = 6;\n",
        after: "const MESSAGE_OVERHEAD_TOKENS = 0;\n",
      },
    ],
  },
  {
    id: "i-resolve-window-override-skipped",
    category: "context-window",
    mechanism:
      "resolveContextWindow para de honrar o override explícito (LOHRA_CONTEXT_WINDOW) — o nível de maior precedência nunca vence mais",
    focus: {
      file: contextWindowTests,
      test: "nível 1: override vence mesmo com catalog, table e floor presentes",
    },
    edits: [
      {
        file: contextWindow,
        before: "  if (override !== undefined && override !== null) {\n",
        after: "  if (false) {\n",
      },
    ],
  },
  {
    id: "j-resolve-window-prefix-boundary-removed",
    category: "context-window",
    mechanism:
      "longestPrefixMatch para de exigir um separador depois do prefixo casado — 'gpt-4' passa a casar com uma entrada futura 'gpt-45' como se fosse a mesma família de modelo",
    focus: {
      file: contextWindowTests,
      test: "nível 3: prefixo exige separador depois — 'gpt-4' não casa com 'gpt-45'",
    },
    edits: [
      {
        file: contextWindow,
        before: "    if (rest && !PREFIX_BOUNDARY_CHARS.has(rest.charAt(0))) continue;\n",
        after: "    if (false) continue;\n",
      },
    ],
  },
  {
    id: "k-windows-cache-null-overwrites-known-window",
    category: "windows-cache",
    mechanism:
      "mergeProviderWindows deixa um valor fresco null apagar um número já conhecido — a fusão por modelo do cache de janelas deixa de preservar o que já foi visto",
    focus: {
      file: catalogPricingTests,
      test: "merges by model: a fresh null never overwrites a known number, a fresh number always wins",
    },
    edits: [
      {
        file: windowsCache,
        before: "    merged[model] = freshValue !== null ? freshValue : (previousValue ?? null);\n",
        after: "    merged[model] = freshValue;\n",
      },
    ],
  },
  {
    id: "l-windows-cache-load-cap-removed",
    category: "windows-cache",
    mechanism:
      "capAndFreezeAllProviders para de capar cada provedor a MAX_MODELS_PER_PROVIDER na leitura — um arquivo em disco acima do teto (escrito por outra versão ou editado à mão) deixa de ser cortado ao carregar",
    focus: {
      file: catalogPricingTests,
      test: "caps a provider at MAX_MODELS_PER_PROVIDER entries when loading too, even if the file on disk has more",
    },
    edits: [
      {
        file: windowsCache,
        before: "    result[provider] = capProvider(windows);\n",
        after: "    result[provider] = windows;\n",
      },
    ],
  },
  {
    id: "m-compact-history-lock-check-bypassed",
    category: "session-repository",
    mechanism:
      "compactHistory para de checar, dentro da própria transação, se holder ainda detém o compression_lock — a escrita deixa de ser recusada para um holder sem o lock (invariante 4: escrita cross-process sob lease/fence)",
    focus: {
      file: stateLocksTests,
      test: "refuses to write when the caller doesn't currently hold the lock",
    },
    edits: [
      {
        file: sessionRepository,
        before: "      if (heldLock === undefined) {\n",
        after: "      if (false) {\n",
      },
    ],
  },
  {
    id: "n-compact-history-message-count-not-net",
    category: "session-repository",
    mechanism:
      "compactHistory soma só as linhas inseridas ao message_count, sem subtrair as linhas desativadas — depois de uma compactação, message_count conta as mensagens já removidas como se ainda estivessem ativas",
    focus: {
      file: stateLocksTests,
      test: "rewrites the active history: summary first, kept tail after it, in order",
    },
    edits: [
      {
        file: sessionRepository,
        before:
          '        .prepare("UPDATE sessions SET message_count = message_count - ? + ? WHERE id = ?")\n        .run(rows.length, inserted, sessionId);\n',
        after:
          '        .prepare("UPDATE sessions SET message_count = message_count + ? WHERE id = ?")\n        .run(inserted, sessionId);\n',
      },
    ],
  },
  {
    id: "o-load-messages-active-filter-dropped",
    category: "session-repository",
    mechanism:
      "loadMessages passa a listar mensagens desativadas por padrão (activeOnly = false) — depois de uma compactação, o histórico visto pelo chamador volta a incluir as linhas que compactHistory desativou",
    focus: {
      file: stateLocksTests,
      test: "rewrites the active history: summary first, kept tail after it, in order",
    },
    edits: [
      {
        file: sessionRepository,
        before: "    activeOnly = true,\n",
        after: "    activeOnly = false,\n",
      },
    ],
  },
  // --- abort em voo (M16, épico #490, issue #519) -------------------------
  // Issue #519 (M16-S4): S1-S3/S5/S6's own estimator/signal-forwarding code
  // lives under `src/conversation/**`/`src/context/**`, this slice's own
  // `srcGlobs` — never `supervision`'s (`src/workflow/**`,
  // `src/orchestration/**`, `src/transports/**`), which the issue's original
  // id assignment mistakenly targeted.
  {
    id: "p-partial-usage-text-factor-dense",
    category: "partial-usage-text-factor-dense",
    mechanism:
      "estimatePartialUsage cobra partial.text no fator JSON (mais denso), em vez do fator de prosa — superestima o custo de texto parcial",
    focus: {
      file: tokenEstimateTests,
      test: "pins the exact output token count for 29 chars of partial text (29 / 2.9 = 10, no remainder)",
    },
    edits: [
      {
        file: tokenEstimate,
        before: "    charsToTokens(partial.text.length, TEXT_CHARS_PER_TOKEN) +",
        after: "    charsToTokens(partial.text.length, JSON_CHARS_PER_TOKEN) +",
      },
    ],
  },
  {
    id: "q-stream-signal-dropped-in-streaming-branch",
    category: "stream-signal-dropped-in-streaming-branch",
    mechanism:
      "AnthropicMessagesModel.complete deixa de encaminhar request.signal ao chamar client.stream no ramo streaming — um abort do caller nunca alcança o transporte",
    focus: {
      file: abortInFlightTests,
      test: "forwards ModelRequest.signal into the streaming branch of both model wrappers",
    },
    edits: [
      {
        file: providerModel,
        before:
          "      ? this.client.stream(kwargs, request.onText ? { onText: request.onText } : {}, request.signal)",
        after:
          "      ? this.client.stream(kwargs, request.onText ? { onText: request.onText } : {}, undefined)",
      },
    ],
  },
];

const root = resolve(import.meta.dirname, "../..");
const evidenceDirectory = resolve(root, ".mutation-evidence/t23");

function headSha(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error("cannot resolve candidate HEAD");
  return result.stdout.trim();
}

function focusKey(focus: Focus): string {
  return `${focus.file}::${focus.test}`;
}

/**
 * Garante que o foco roda pelo menos um teste e sai verde ANTES da mutação
 * — mesma guarda de `web-tools.ts` (issue #152/#148): sem ela, um foco
 * obsoleto (`-t` que não casa com teste nenhum) sairia com `exitCode: 0` e
 * `ranTests: 0`, e `classify` leria isso como um sobrevivente silencioso em
 * vez do setup quebrado que é de fato.
 */
function assertBaselineGreen(directory: string, focus: Focus): void {
  const outcome = runFocusedVitest(directory, focus);
  if (outcome.exitCode !== 0 || outcome.ranTests === 0) {
    throw new Error(
      `baseline for focus ${focusKey(focus)} is not green with tests ` +
        `(exit=${String(outcome.exitCode)}, ran=${String(outcome.ranTests)})`,
    );
  }
}

export function main(): void {
  const candidateSha = headSha();
  const sandbox = prepareArchiveSandbox(root, candidateSha);
  try {
    const files = [
      ...new Set(contextWindowMutants.flatMap((mutant) => mutant.edits.map((edit) => edit.file))),
    ];
    const snapshot = snapshotFiles(sandbox, files);

    const foci = new Map<string, Focus>();
    for (const mutant of contextWindowMutants) foci.set(focusKey(mutant.focus), mutant.focus);
    for (const focus of foci.values()) assertBaselineGreen(sandbox, focus);

    const results = contextWindowMutants.map((mutant) => {
      restoreAll(sandbox, snapshot);
      for (const edit of mutant.edits) applyEditExactlyOnce(sandbox, edit, mutant.id);
      const outcome = runFocusedVitest(sandbox, mutant.focus);
      // `runFocusedVitest` lança se o vitest não produzir JSON (harness.ts,
      // fail-closed). A guarda abaixo cobre o caso que ainda passa por JSON
      // válido: um foco que, pós-mutação, deixou de coletar teste nenhum
      // (`ranTests: 0`) nunca conta como morto.
      const killed = outcome.ranTests > 0 && classify(outcome.exitCode, outcome.failedTests);
      return {
        id: mutant.id,
        category: mutant.category,
        mechanism: mutant.mechanism,
        focus: mutant.focus,
        ranTests: outcome.ranTests,
        killed,
        killedBy: outcome.failedTests,
        files: [...new Set(mutant.edits.map((edit) => edit.file))].sort(),
      };
    });

    restoreAll(sandbox, snapshot);
    const restored = [...foci.entries()].map(([key, focus]) => {
      const outcome = runFocusedVitest(sandbox, focus);
      return { focus: key, green: outcome.exitCode === 0 && outcome.ranTests > 0 };
    });
    const restoreGreen = restored.every((entry) => entry.green);

    const survivors = results.filter((result) => !result.killed).map((result) => result.id);
    const byCategory = Object.fromEntries(
      [...new Set(results.map((result) => result.category))]
        .sort()
        .map((category) => [
          category,
          results.filter((result) => result.category === category).length,
        ]),
    );
    const report: MutationReport = {
      suite: "t23-context-window-mutations",
      candidateSha,
      killed: results.length - survivors.length,
      total: results.length,
      survivors,
      restoreGreen,
      byCategory,
    };
    writeReport(evidenceDirectory, report);
    process.stdout.write(
      `${JSON.stringify({
        suite: report.suite,
        candidateSha,
        killed: report.killed,
        total: report.total,
        byCategory,
        survivors,
        restoreGreen,
        mutants: results,
        evidence: resolve(evidenceDirectory, "mutations.json"),
      })}\n`,
    );
    process.exitCode = survivors.length === 0 && restoreGreen ? 0 : 1;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

if (ehEntryPoint(import.meta.url)) main();
