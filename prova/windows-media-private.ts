// Issue #918 (épico #899, ADR 0006): a mídia gerada é privada por padrão no
// Windows. `windows-media-protection.test.ts` prova, com a proteção injetada, que
// diretório, destino e stage são protegidos antes dos bytes e que a publicação
// é verificada antes e depois do rename; `media-persistence.test.ts` mantém o
// contrato POSIX (stage 0600, final 0644), a atomicidade e as checagens de
// identidade no mesmo fluxo.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/windows-media-protection.test.ts", "tests/media-persistence.test.ts"],
} satisfies Declaracao;
