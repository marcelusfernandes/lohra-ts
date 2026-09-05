import { describe, expect, it } from "vitest";

import { montarResumo } from "../scripts/prova/resumo.js";
import type { ResultadoVitest } from "../scripts/prova/tipos.js";

describe("montarResumo", () => {
  it("is ok with total = tests executed when every declared file ran and passed", () => {
    const resultado: ResultadoVitest = {
      total: 2,
      arquivos: [
        {
          arquivo: "tests/a.test.ts",
          colecionou: true,
          testes: [
            { nome: "a passes", passou: true },
            { nome: "a also passes", passou: true },
          ],
        },
      ],
    };
    const resumo = montarResumo(["tests/a.test.ts"], resultado);
    expect(resumo).toEqual({ ok: true, total: 2, falhas: [] });
  });

  it("has exactly the keys ok, total, falhas", () => {
    const resultado: ResultadoVitest = { total: 0, arquivos: [] };
    const resumo = montarResumo([], resultado);
    expect(Object.keys(resumo).sort()).toEqual(["falhas", "ok", "total"]);
  });

  it('marks a declared file absent from the report as "<arquivo> did not run"', () => {
    const resultado: ResultadoVitest = {
      total: 1,
      arquivos: [
        {
          arquivo: "tests/a.test.ts",
          colecionou: true,
          testes: [{ nome: "a passes", passou: true }],
        },
      ],
    };
    const resumo = montarResumo(["tests/a.test.ts", "tests/missing.test.ts"], resultado);
    expect(resumo.ok).toBe(false);
    expect(resumo.falhas).toContainEqual(
      expect.objectContaining({ nome: "tests/missing.test.ts did not run" }),
    );
  });

  it("collects a failing test as a falha and turns ok false", () => {
    const resultado: ResultadoVitest = {
      total: 1,
      arquivos: [
        {
          arquivo: "tests/a.test.ts",
          colecionou: true,
          testes: [{ nome: "a fails", passou: false, motivo: "expected true, got false" }],
        },
      ],
    };
    const resumo = montarResumo(["tests/a.test.ts"], resultado);
    expect(resumo.ok).toBe(false);
    expect(resumo.falhas).toContainEqual({ nome: "a fails", motivo: "expected true, got false" });
  });

  it("collects a file that failed to collect (no assertions) as a falha", () => {
    const resultado: ResultadoVitest = {
      total: 0,
      arquivos: [
        {
          arquivo: "tests/broken.test.ts",
          colecionou: false,
          motivoColeta: "SyntaxError: Unexpected token",
          testes: [],
        },
      ],
    };
    const resumo = montarResumo(["tests/broken.test.ts"], resultado);
    expect(resumo.ok).toBe(false);
    expect(resumo.falhas).toContainEqual(
      expect.objectContaining({
        nome: "tests/broken.test.ts",
        motivo: "SyntaxError: Unexpected token",
      }),
    );
  });

  it("never mutates the declarados array it receives", () => {
    const declarados = ["tests/a.test.ts"];
    const frozen = Object.freeze([...declarados]);
    const resultado: ResultadoVitest = { total: 0, arquivos: [] };
    expect(() => montarResumo(frozen, resultado)).not.toThrow();
    expect(frozen).toEqual(["tests/a.test.ts"]);
  });
});
