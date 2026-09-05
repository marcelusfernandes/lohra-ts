import { describe, expect, it } from "vitest";

import { normalizarRelatorioVitest } from "../scripts/prova/vitest-relatorio.js";

const ROOT = "/repo";

describe("normalizarRelatorioVitest", () => {
  it("normalizes absolute file names to root-relative paths and total", () => {
    const bruto = {
      numTotalTests: 2,
      testResults: [
        {
          name: "/repo/tests/a.test.ts",
          status: "passed",
          assertionResults: [
            { fullName: "a > passes", title: "passes", status: "passed" },
            { fullName: "a > also passes", title: "also passes", status: "passed" },
          ],
        },
      ],
    };
    expect(normalizarRelatorioVitest(ROOT, bruto)).toEqual({
      total: 2,
      arquivos: [
        {
          arquivo: "tests/a.test.ts",
          colecionou: true,
          testes: [
            { nome: "a > passes", passou: true },
            { nome: "a > also passes", passou: true },
          ],
        },
      ],
    });
  });

  it("marks a failed test with its failureMessages joined as motivo", () => {
    const bruto = {
      numTotalTests: 1,
      testResults: [
        {
          name: "/repo/tests/a.test.ts",
          status: "failed",
          assertionResults: [
            {
              fullName: "a > fails",
              title: "fails",
              status: "failed",
              failureMessages: ["expected true, got false"],
            },
          ],
        },
      ],
    };
    const resultado = normalizarRelatorioVitest(ROOT, bruto);
    expect(resultado.arquivos[0]?.testes).toEqual([
      { nome: "a > fails", passou: false, motivo: "expected true, got false" },
    ]);
  });

  it("marks a file with no assertionResults and status failed as colecionou:false", () => {
    const bruto = {
      numTotalTests: 0,
      testResults: [
        {
          name: "/repo/tests/broken.test.ts",
          status: "failed",
          message: "SyntaxError: Unexpected token",
          assertionResults: [],
        },
      ],
    };
    expect(normalizarRelatorioVitest(ROOT, bruto)).toEqual({
      total: 0,
      arquivos: [
        {
          arquivo: "tests/broken.test.ts",
          colecionou: false,
          motivoColeta: "SyntaxError: Unexpected token",
          testes: [],
        },
      ],
    });
  });

  it("excludes skipped/todo tests from total and does not treat them as failures", () => {
    const bruto = {
      numTotalTests: 3,
      testResults: [
        {
          name: "/repo/tests/a.test.ts",
          status: "passed",
          assertionResults: [
            { fullName: "a > passes", title: "passes", status: "passed" },
            { fullName: "a > skipped", title: "skipped", status: "skipped" },
            { fullName: "a > todo", title: "todo", status: "todo" },
          ],
        },
      ],
    };
    const resultado = normalizarRelatorioVitest(ROOT, bruto);
    // Only the one executed (passed) test counts toward total; skipped/todo
    // are neither counted nor reported as testes at all — they never ran,
    // so they can be neither a pass nor a "did not run" false negative.
    expect(resultado.total).toBe(1);
    expect(resultado.arquivos[0]?.testes).toEqual([{ nome: "a > passes", passou: true }]);
  });

  it("fails closed on a malformed report instead of returning an empty result silently", () => {
    expect(() => normalizarRelatorioVitest(ROOT, {})).toThrow();
    expect(() => normalizarRelatorioVitest(ROOT, null)).toThrow();
    expect(() => normalizarRelatorioVitest(ROOT, { numTotalTests: "nope" })).toThrow();
  });
});
