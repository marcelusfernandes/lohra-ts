// Issue #213: `scripts/pack-check.ts:135` declarava `expectedResult` como
// `'{"ok": true, "bytes_written": 10, "path": "package-written/out.txt"}'`
// (com espaços depois dos dois-pontos) e comparava por igualdade de string
// contra a serialização compacta do runtime (`stringifyJsonPreservingNumbers`
// — `src/tools/envelope.ts`), então `npm run pack:check` reprovava com
// `PACK_CHAT_MISMATCH` mesmo com o chat correto (evidência na PR #212).
//
// `assertStructuralMatch` e `extractLastToolResultContent` são puras — a
// primeira faz `JSON.parse` dos dois lados e nunca compara strings
// literalmente; a segunda lê o `projected` log (JSONL de
// `scripts/stub/server.ts`) já em memória, sem depender de `npm pack`. Isso
// é o que permite este arquivo provar o comportamento sem rodar o pipeline
// caro (`npm run pack:check`, que continua sendo a prova de ponta a ponta,
// colada manualmente no test plan da PR).
import { describe, expect, it } from "vitest";

import { assertStructuralMatch, extractLastToolResultContent } from "../scripts/pack-check.js";

const COMPACT = '{"ok":true,"bytes_written":10,"path":"package-written/out.txt"}';
// A forma exatamente como estava hardcoded na issue — com espaços — prova
// que a comparação agora é imune à formatação, não só ao valor.
const SPACED = '{"ok": true, "bytes_written": 10, "path": "package-written/out.txt"}';

describe("assertStructuralMatch", () => {
  it("não lança quando os dois lados são estruturalmente iguais, mesmo com formatação diferente", () => {
    expect(() => {
      assertStructuralMatch(SPACED, COMPACT);
    }).not.toThrow();
  });

  it("lança PACK_CHAT_MISMATCH nomeando o campo divergente quando um valor diverge", () => {
    const divergent = '{"ok":true,"bytes_written":999,"path":"package-written/out.txt"}';
    expect(() => {
      assertStructuralMatch(SPACED, divergent);
    }).toThrow(/PACK_CHAT_MISMATCH.*bytes_written/);
  });

  it("lança PACK_CHAT_MISMATCH com uma causa nomeada quando o lado atual não é JSON válido", () => {
    expect(() => {
      assertStructuralMatch(SPACED, "não é json");
    }).toThrow(/PACK_CHAT_MISMATCH/);
  });
});

describe("extractLastToolResultContent", () => {
  it("devolve o content da mensagem role:tool da última requisição do log", () => {
    const log = [
      JSON.stringify({
        seq: 1,
        body: { messages: [{ role: "system" }, { role: "user" }] },
      }),
      JSON.stringify({
        seq: 2,
        body: {
          messages: [
            { role: "system" },
            { role: "user" },
            { role: "assistant" },
            { role: "tool", tool_call_id: "call_1", content: COMPACT },
          ],
        },
      }),
    ].join("\n");
    expect(extractLastToolResultContent(log)).toBe(COMPACT);
  });

  it("devolve null quando nenhuma requisição tem mensagem role:tool", () => {
    const log = JSON.stringify({
      seq: 1,
      body: { messages: [{ role: "system" }, { role: "user" }] },
    });
    expect(extractLastToolResultContent(log)).toBeNull();
  });

  it("ignora linhas vazias, mas lança numa linha não vazia que não é JSON válido", () => {
    // O log é escrito em processo por scripts/stub/server.ts via
    // JSON.stringify; uma linha não vazia corrompida é o próprio stub
    // quebrado, não uma entrada normal a pular em silêncio.
    const log = ["", "não é json", ""].join("\n");
    expect(() => {
      extractLastToolResultContent(log);
    }).toThrow(/PACK_CHAT_MISMATCH.*projected_log/);
  });
});
