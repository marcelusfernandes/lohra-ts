// Issue #511 (follow-up de #498, PR #507, veredito non_blocking 1): a
// re-sanitização de `publicAuditEvent` (escrita em `append`, releitura em
// `parseEvent`) não era idempotente em TAMANHO — um valor já embrulhado num
// marcador (`{state}`, com ou sem `characters`/`items`/`fields`) sofria uma
// SEGUNDA passada por `rawMarker` (audit-model.ts) que o tratava como um
// objeto opaco qualquer e o reembrulhava (`{state, fields: N}`), crescendo a
// cada passada. Um evento gravado abaixo de `AUDIT_EVENT_BYTES` podia
// re-derivar acima do teto e a leitura devolvia `audit.truncated` para uma
// linha que `event_markers`/`notices` (`src/state/audit-repository.ts`,
// filtrados pela COLUNA `event_type`) nunca contavam como truncada —
// página e marcadores discordando um do outro.
//
// Arquivo próprio (glob `tests/workflow-audit-model*.test.ts` dos `Files` da
// issue) para não fazer `tests/workflow-audit-live.test.ts` (1211 linhas) ou
// `tests/workflow-audit-tool.test.ts` (775) crescerem.
import { describe, expect, it } from "vitest";

import {
  AUDIT_EVENT_BYTES,
  publicAuditEvent,
  safeAuditMetadata,
  type AuditInput,
} from "../src/workflow/audit-model.js";

// A palavra "chave desconhecida" no corpo da issue: um nome de campo que não
// está em nenhum dos vocabulários fechados de `audit-model.ts` (RAW_FIELDS,
// IDENTITY_FIELDS, NUMBER_FIELDS, BOOLEAN_FIELDS, PATH_FIELDS,
// CONTAINER_FIELDS, OPAQUE_FIELDS, SAFE_STRING_VALUES) — sempre vira um
// `rawMarker` na primeira passada, o caso que expõe o bug.
function unknownKeys(count: number, value: unknown): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (let index = 0; index < count; index += 1) out[`unknown_field_${String(index)}`] = value;
  return out;
}

// Corpus com marcadores já gravados (todo SAFE_MARKER_STATES, com e sem
// characters/items/fields/bytes), chaves desconhecidas de todo tipo
// primitivo, campos RAW_FIELDS (públicos e privados), containers aninhados,
// binário, e arrays de path — a segunda passada de `safeAuditMetadata` sobre
// CADA um destes precisa devolver exatamente os mesmos bytes da primeira.
function corpus(): readonly Readonly<Record<string, unknown>>[] {
  return [
    unknownKeys(16, true),
    unknownKeys(16, 42),
    unknownKeys(16, "some text value"),
    unknownKeys(16, { a: 1, b: 2 }),
    unknownKeys(16, [1, 2, 3]),
    unknownKeys(16, new Uint8Array(8)),
    unknownKeys(16, null),
    { prompt: "raw prompt text", content: { nested: "object" }, result: [1, 2, 3] },
    { reasoning: "private raw text", reasoning_content: { a: 1 } },
    { prompt: { state: "excluded_by_policy", characters: 12 } },
    { reasoning: { state: "excluded_private_state", fields: 2 } },
    { metadata: { budget: { tokens_in: 5, unknown_nested: "x" } } },
    { node_path: ["a", "b", "c"], branch_path: [1, 2, 3] },
    { error_kind: "auth_failed" },
    { deep: { a: { b: { c: { d: { e: "past depth 4" } } } } } },
    { top: { state: "truncated", side: "depth" } },
    { top: { state: "observed", items: 3 } },
    { top: { state: "unavailable", bytes: 10 } },
    { top: { state: "not_observed" } },
    { top: { state: "not_yet_available" } },
    { top: { state: "redacted" } },
  ];
}

describe("safeAuditMetadata — idempotência de tamanho e conteúdo (#511)", () => {
  it("é idempotente byte-a-byte para cada item do corpus, aplicada 1x, 2x e 3x", () => {
    for (const input of corpus()) {
      const once = JSON.stringify(safeAuditMetadata(input));
      const twice = JSON.stringify(safeAuditMetadata(safeAuditMetadata(input)));
      const thrice = JSON.stringify(safeAuditMetadata(safeAuditMetadata(safeAuditMetadata(input))));
      expect(twice, `MUTATION_CAUSE:M511-resanitize-grows ${once}`).toBe(once);
      expect(thrice).toBe(twice);
    }
  });

  it("publicAuditEvent(publicAuditEvent(x)) é idêntico byte-a-byte a publicAuditEvent(x)", () => {
    for (const payload of corpus()) {
      const input: AuditInput = { event_type: "leaf.started", payload };
      const once = publicAuditEvent("run-idempotent", 7, input, 100);
      const twice = publicAuditEvent(
        "run-idempotent",
        7,
        { event_type: "leaf.started", payload: once.data },
        100,
      );
      expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    }
  });
});

describe("publicAuditEvent — reprodução do revisor: evento < 2048 bytes não re-deriva audit.truncated (#511)", () => {
  it("um leaf.started com muitas chaves desconhecidas, gravado abaixo do teto, permanece leaf.started na releitura", () => {
    // Construção calibrada (via experimentação local) para ficar
    // confortavelmente abaixo de AUDIT_EVENT_BYTES na primeira passada, mas
    // que crescia o suficiente numa segunda passada (pré-fix) para
    // ultrapassar o teto e re-derivar como audit.truncated — exatamente o
    // reproduzido pelo revisor na PR #507 (leaf.started, 40 chaves
    // desconhecidas, 1618 bytes gravados -> 2058 re-derivados).
    const payload: Record<string, unknown> = {};
    for (let index = 0; index < 16; index += 1)
      payload[`unknown_key_number_${String(index)}_${"k".repeat(30)}`] = true;
    const identity = {
      segment_id: "s".repeat(128),
      node_id: "n".repeat(64),
      sub_id: "u".repeat(128),
    };
    const input: AuditInput = { event_type: "leaf.started", ...identity, payload };
    const written = publicAuditEvent("run-id-1234567890", 1, input, 1);
    expect(written.event_type).toBe("leaf.started");
    expect(Buffer.byteLength(JSON.stringify(written), "utf8")).toBeLessThan(AUDIT_EVENT_BYTES);

    // Simula a releitura: `parseEvent` (audit-repository.ts) reconstrói o
    // `AuditInput` a partir das COLUNAS da linha (`segment_id`/`node_id`/
    // `sub_id`, gravadas à parte de `data`) e do `data` já sanitizado como
    // `payload` — a segunda passada de sanitização.
    const reread = publicAuditEvent(
      "run-id-1234567890",
      1,
      { event_type: "leaf.started", ...identity, payload: written.data },
      1,
    );
    expect(reread.event_type, "MUTATION_CAUSE:M511-page-truncated-mismatch").toBe("leaf.started");
    expect(JSON.stringify(reread)).toBe(JSON.stringify(written));
  });
});
