// Issue #558: `tests/media-handlers.test.ts` («vision_analyze handler >
// keeps path and cause in a read-failure envelope») dependia do sufixo
// aleatório do `mkdtemp` — quando ele começava com "sk" (ou "key"/"token"/
// "secret"), a regex SECRET de `src/media/errors.ts:4` redigia o caminho e
// o teste falhava de forma intermitente (visto em `checks (22)` na PR
// #556). O teste passa agora a forçar um segmento "sk123456" de propósito
// e a afirmar só sobre a cauda determinística do caminho (`fixture/
// unreadable.png`), que nunca cai sob a regex — `[-_A-Za-z0-9]` não inclui
// `/`, então uma redação no segmento pai nunca alcança a cauda.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/media-handlers.test.ts"],
} satisfies Declaracao;
