// Issue #75: renomear python-truthy/PythonNumberKind para nomes que
// descrevem a regra deste runtime (presença/ausência de valor JSON e
// categoria numérica do JSON de entrada), sem citar Python, e tirar
// python3 da dica de `lohra tiers list`. Prova cobre os dois módulos
// renomeados e os dois consumidores mais sensíveis à mudança de import
// (config/tools do MCP, que chamam a função de presença várias vezes).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/json-presence.test.ts",
    "tests/tools-core.test.ts",
    "tests/mcp-config.test.ts",
    "tests/mcp-tools.test.ts",
  ],
} satisfies Declaracao;
