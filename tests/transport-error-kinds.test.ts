import { describe, expect, it } from "vitest";

import {
  ERROR_KINDS,
  ERROR_KIND_SET,
  classifyProviderError,
  isErrorKind,
  ProviderCallFailed,
  type ErrorKind,
} from "../src/transports/index.js";

describe("ERROR_KINDS vocabulary (#397)", () => {
  it("is the closed set from the épico #396 mapping", () => {
    expect(ERROR_KINDS).toEqual([
      "quota_exhausted",
      "auth_failed",
      "model_not_found",
      "route_fault",
      "sandbox_denied",
      "timeout",
      "cancelled",
      "context_length",
      "unknown",
    ]);
  });

  it("ERROR_KIND_SET mirrors ERROR_KINDS", () => {
    expect(ERROR_KIND_SET.size).toBe(ERROR_KINDS.length);
    for (const kind of ERROR_KINDS) expect(ERROR_KIND_SET.has(kind)).toBe(true);
  });

  it.each(ERROR_KINDS)("isErrorKind accepts %s", (kind) => {
    expect(isErrorKind(kind)).toBe(true);
  });

  it.each(["quota-exhausted", "AUTH_FAILED", "", 42, null, undefined])(
    "isErrorKind rejects %s",
    (value) => {
      expect(isErrorKind(value)).toBe(false);
    },
  );
});

// `classifyProviderError` continua devolvendo `ErrorKind | null`: os
// gatilhos de quota (RateLimitError, 429, quotaCodes) ficam inalterados
// (tests/transports-errors.test.ts cobre esses casos e não pode regredir).
// Aqui cobrimos só os kinds novos que #397 acrescenta ao classificador,
// sem tocar em statusCode 5xx nem no fallthrough genérico
// `ProviderCallFailed → "unknown"` — ambos colidem com um teste pinado fora
// do escopo desta issue (`tests/orchestration-child-runner.test.ts:341`,
// "maps a 500 upstream failure to error_kind:null (L15 boundary)", e
// `tests/transports-errors.test.ts:18`, `statusCode: 500 → null`); a issue
// #397 registra a colisão para o orquestrador decidir.
describe("classifyProviderError: novos kinds (#397)", () => {
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

  it("o tipo devolvido é atribuível a ErrorKind | null", () => {
    const kind: ErrorKind | null = classifyProviderError(
      new ProviderCallFailed("unauthorized", { statusCode: 401 }),
    );
    expect(kind).toBe("auth_failed");
  });
});
