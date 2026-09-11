import { describe, expect, it } from "vitest";

import { ProviderCallFailed, classifyProviderError } from "../src/transports/index.js";
import * as transports from "../src/transports/index.js";
import type { ErrorKind } from "../src/transports/index.js";

// #397 (M8-1): `controle-negativo` exige que este arquivo COLETE de verdade
// contra a base (origin/main), onde `ERROR_KINDS`/`ERROR_KIND_SET`/
// `isErrorKind` ainda não existem. `it.each` chama `.every` de forma
// SÍNCRONA na coleta (antes de qualquer `it` rodar) — passar um valor
// importado que é `undefined` na base derruba o arquivo inteiro
// ("structural-red": 0 testes coletados), não uma asserção reprovada
// ("assertion-red", o que o controle-negativo exige). `EXPECTED_KINDS` é
// uma cópia literal local, nunca `undefined`; o `import * as transports`
// só é lido DENTRO de cada `it()`, onde `transports.ERROR_KINDS` sendo
// `undefined` na base vira uma asserção reprovada — não uma falha de
// coleta. `classifyProviderError`/`ProviderCallFailed` já existiam antes
// de #397, então o import nomeado deles é seguro na base.
const EXPECTED_KINDS = [
  "quota_exhausted",
  "auth_failed",
  "model_not_found",
  "route_fault",
  "sandbox_denied",
  "timeout",
  "cancelled",
  "context_length",
  "unknown",
] as const;

describe("ERROR_KINDS vocabulary (#397)", () => {
  it("is the closed set from the épico #396 mapping", () => {
    expect(transports.ERROR_KINDS).toEqual(EXPECTED_KINDS);
  });

  it("ERROR_KIND_SET mirrors ERROR_KINDS", () => {
    expect(transports.ERROR_KIND_SET.size).toBe(EXPECTED_KINDS.length);
    for (const kind of EXPECTED_KINDS) expect(transports.ERROR_KIND_SET.has(kind)).toBe(true);
  });

  it.each(EXPECTED_KINDS)("isErrorKind accepts %s", (kind) => {
    expect(transports.isErrorKind(kind)).toBe(true);
  });

  it.each(["quota-exhausted", "AUTH_FAILED", "", 42, null, undefined])(
    "isErrorKind rejects %s",
    (value) => {
      expect(transports.isErrorKind(value)).toBe(false);
    },
  );
});

// `classifyProviderError` devolve `ErrorKind | null`: os gatilhos de quota
// (RateLimitError, 429, quotaCodes) ficam inalterados
// (tests/transports-errors.test.ts cobre esses casos e não pode regredir;
// o caso 429 abaixo é só um guarda de regressão local). A colisão original
// com tests/transports-errors.test.ts:18 e
// tests/orchestration-child-runner.test.ts (statusCode 500 -> null) foi
// resolvida pelo orquestrador emendando o `## Files` da issue #397
// (2026-09-12, opção (a)): os dois pinos agora esperam `route_fault`, e o
// mapeamento completo do AC (5xx -> route_fault; qualquer outro
// ProviderCallFailed -> unknown, nunca null) está coberto aqui.
describe("classifyProviderError: novos kinds (#397)", () => {
  it("statusCode 429 -> quota_exhausted (guarda de regressão)", () => {
    const error = new ProviderCallFailed("rate limited", { statusCode: 429 });
    expect(classifyProviderError(error)).toBe("quota_exhausted");
  });

  it("statusCode 401 -> auth_failed", () => {
    const error = new ProviderCallFailed("unauthorized", { statusCode: 401 });
    expect(classifyProviderError(error)).toBe("auth_failed");
  });

  it("statusCode 403 -> auth_failed", () => {
    const error = new ProviderCallFailed("forbidden", { statusCode: 403 });
    expect(classifyProviderError(error)).toBe("auth_failed");
  });

  it("statusCode 404 com code de modelo -> model_not_found", () => {
    const error = new ProviderCallFailed("The model does not exist", {
      statusCode: 404,
      code: "model_not_found",
    });
    expect(classifyProviderError(error)).toBe("model_not_found");
  });

  it("statusCode 404 com indício de modelo no payload -> model_not_found", () => {
    const error = new ProviderCallFailed("boom", {
      statusCode: 404,
      payload: { error: { code: "model_not_found", message: "no such model" } },
    });
    expect(classifyProviderError(error)).toBe("model_not_found");
  });

  it("statusCode 404 com indício de modelo só na mensagem -> model_not_found", () => {
    const error = new ProviderCallFailed("model 'gpt-nope' not found", { statusCode: 404 });
    expect(classifyProviderError(error)).toBe("model_not_found");
  });

  it.each(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET"])(
    "código de rede %s -> route_fault (erro que não chega embrulhado em ProviderCallFailed)",
    (code) => {
      const error = Object.assign(new Error("network down"), { code });
      expect(classifyProviderError(error)).toBe("route_fault");
    },
  );

  it("erro que não é de provedor continua null", () => {
    expect(classifyProviderError(new Error("plain"))).toBeNull();
  });

  it("statusCode 500 -> route_fault", () => {
    const error = new ProviderCallFailed("boom", {
      statusCode: 500,
      payload: { error: "boom" },
    });
    expect(classifyProviderError(error)).toBe("route_fault");
  });

  it.each([500, 502, 503, 599])("statusCode 5xx (%d) -> route_fault", (statusCode) => {
    const error = new ProviderCallFailed("boom", { statusCode });
    expect(classifyProviderError(error)).toBe("route_fault");
  });

  it("ProviderCallFailed sem mapeamento (400) -> unknown, nunca null", () => {
    const error = new ProviderCallFailed("bad request", { statusCode: 400 });
    expect(classifyProviderError(error)).toBe("unknown");
  });

  it("ProviderCallFailed sem statusCode nenhum -> unknown, nunca null", () => {
    expect(classifyProviderError(new ProviderCallFailed("mystery"))).toBe("unknown");
  });

  it("o tipo devolvido é atribuível a ErrorKind | null", () => {
    const kind: ErrorKind | null = classifyProviderError(
      new ProviderCallFailed("unauthorized", { statusCode: 401 }),
    );
    expect(kind).toBe("auth_failed");
  });
});
