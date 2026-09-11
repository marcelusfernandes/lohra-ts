// Issue #334: `runPipeline` (engine.ts:~545) creditava um respawn a
// `leafRespawns` antes de saber se a tentativa seguinte de um estágio
// realmente ia spawnar — o mesmo atalho pausado de `collectLeaf`
// (engine.ts:235-236) já corrigido em `runAgent` por #321.
// `tests/workflow-agent-retries.test.ts` cobre o describe novo (pausa entre
// tentativas de um estágio de `pipeline`, sem spawn extra) e os dois
// cenários fora de pausa que este fix não pode alterar (vazio → retry até o
// teto, null → sem retry).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-agent-retries.test.ts"],
} satisfies Declaracao;
