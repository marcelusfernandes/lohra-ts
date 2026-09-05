// Teste unitário de validarDeclaracao — importa run.ts diretamente. Seguro
// porque run.ts só chama main() quando é o entry point (process.argv[1]),
// nunca quando importado por um teste.
import { afterEach, describe, expect, it, vi } from "vitest";

import { validarDeclaracao } from "../scripts/prova/run.js";

// Um `expect` que falha entre o spy e o `mockRestore()` manual deixaria
// `process.stderr.write` mockado para os testes seguintes. `afterEach`
// restaura mesmo quando o teste falha no meio.
afterEach(() => {
  vi.restoreAllMocks();
});

function comExitEspiado<T>(fn: () => T): { resultado?: T; codigoSaida?: number } {
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((codigo?: number) => {
    throw new ExitSimulado(codigo ?? 0);
  }) as never);
  try {
    return { resultado: fn() };
  } catch (erro) {
    if (erro instanceof ExitSimulado) return { codigoSaida: erro.codigo };
    throw erro;
  } finally {
    exitSpy.mockRestore();
  }
}

class ExitSimulado extends Error {
  constructor(readonly codigo: number) {
    super(`exit(${String(codigo)})`);
  }
}

describe("validarDeclaracao", () => {
  it("accepts a minimal valid declaration", () => {
    const { resultado } = comExitEspiado(() =>
      validarDeclaracao({ unit: ["tests/a.test.ts"] }, "prova/x.ts"),
    );
    expect(resultado).toEqual({ unit: ["tests/a.test.ts"] });
  });

  it("accepts check: true", () => {
    const { resultado } = comExitEspiado(() =>
      validarDeclaracao({ unit: ["tests/a.test.ts"], check: true }, "prova/x.ts"),
    );
    expect(resultado).toEqual({ unit: ["tests/a.test.ts"], check: true });
  });

  it("rejects a default export that is not an object", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { codigoSaida } = comExitEspiado(() => validarDeclaracao("not an object", "prova/x.ts"));
    expect(codigoSaida).toBe(1);
    expect(stderrSpy.mock.calls.join("")).toContain("prova/x.ts");
  });

  it("rejects a default export that is null", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { codigoSaida } = comExitEspiado(() => validarDeclaracao(null, "prova/x.ts"));
    expect(codigoSaida).toBe(1);
  });

  it('rejects "unit" that is not an array', () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { codigoSaida } = comExitEspiado(() =>
      validarDeclaracao({ unit: "tests/a.test.ts" }, "prova/x.ts"),
    );
    expect(codigoSaida).toBe(1);
    expect(stderrSpy.mock.calls.join("")).toContain('"unit"');
  });

  it('rejects a "unit" array containing a non-string item', () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { codigoSaida } = comExitEspiado(() =>
      validarDeclaracao({ unit: ["tests/a.test.ts", 7] }, "prova/x.ts"),
    );
    expect(codigoSaida).toBe(1);
    expect(stderrSpy.mock.calls.join("")).toContain('"unit"');
  });

  it('rejects "check" that is present but not boolean', () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { codigoSaida } = comExitEspiado(() =>
      validarDeclaracao({ unit: ["tests/a.test.ts"], check: "yes" }, "prova/x.ts"),
    );
    expect(codigoSaida).toBe(1);
    expect(stderrSpy.mock.calls.join("")).toContain('"check"');
  });
});
