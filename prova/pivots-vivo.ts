// Issue #448 (M14, achado de revisão do #442): #427 expôs 'pivots' em
// `durableRollup` (durável) mas nunca no envelope VIVO (`resultView`/o
// snapshot "running" ainda não assentado, em `WorkflowService.status`) — um
// supervisor lendo `workflow_status` de um run respondido por ESTE processo
// não via 'pivots', e precisava saber qual canal respondeu para interpretar
// a ausência. Os testes novos em `workflow-route-override.test.ts`
// ("workflow_status's live envelope carries 'pivots' too") pinam o MESMO
// conteúdo nos dois canais para o mesmo run — inclusive um run resumido com
// `route` cuja folha nunca resolve (`HangingPinnedRuntime`, molde do #446),
// onde o envelope vivo ainda está "running" — e que um run sem pivô OMITE a
// chave nos dois canais, igual ao que `durableRollup` já fazia.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-route-override.test.ts"],
} satisfies Declaracao;
