// Issue #308: `recordGroupReplayCost` (engine-utils.ts) re-somava o custo
// das células por branch num HIT do grupo com `deps.cache.get(...).cost ??
// usage()`, sem ler `.hit` — uma célula por branch AUSENTE (por exemplo,
// `putCacheCellWithCost` recusado por "database is locked" só para uma
// branch, com a célula do grupo gravada depois) entrava indistinguível de
// uma branch com custo zero: `nodeCosts` subnotificava em silêncio.
//
// A célula do grupo escrita por ESTA versão sempre carrega `cost: null`,
// que todo `WorkflowCache` devolve como um `Usage` zerado num hit (nunca um
// `null` literal) — então um custo de grupo diferente de zero só pode ser
// de um banco ANTIGO, gravado direto antes de existirem células por branch;
// nesse caso `cacheGet` (engine.ts) já somou o total real e `recordGroupReplayCost`
// não soma de novo (dobraria a conta) nem falta — todas as branches ausentes
// ali são o formato esperado, não um sinal de hardening.
//
// Só o caso "esta versão" (custo do grupo zerado) re-soma as branches; uma
// célula por branch ausente NESSE caso vira fault nomeado
// (`group replay: per-branch cell missing for <branchHash>`) via
// `deps.result.faults`, e o replay continua — o output do grupo já está no
// cache. `engine.ts` só ganhou `hash` como quinto argumento na chamada já
// existente de `recordGroupReplayCost` (linha 478): zero crescimento.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-parallel-cells.test.ts"],
} satisfies Declaracao;
