// Issue #165: os quatro testes de paridade (bounds, harness, process,
// socket-sentinel) perdem o lado Python — o lado TypeScript continua
// provando o mesmo contrato. `tests/sem-python.test.ts` é o meta-teste que
// prende a ausência: nenhum arquivo em `tests/` volta a spawnar
// `python3`/`runPythonProcess`.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/parity/bounds.test.ts",
    "tests/parity/harness.test.ts",
    "tests/parity/process.test.ts",
    "tests/parity/socket-sentinel.test.ts",
    "tests/sem-python.test.ts",
  ],
} satisfies Declaracao;
