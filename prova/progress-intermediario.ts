// Issue #125: persiste `progress_json` a cada nó concluído, não só na
// escrita terminal — um run morto no meio (SIGKILL) deixa de mostrar
// `0/0 nodes` em `list`/`watch`. O primeiro arquivo prova o cenário
// cross-process real (issue #103) com o progresso intermediário visível
// depois do kill; o segundo (arquivo novo pequeno — o de durabilidade já
// passa de 800 linhas e não pode crescer, `contratos`/`arquivo-grande`)
// prova a escrita sob fence: com aquisição obsoleta, a escrita de progresso
// não sobrescreve a linha.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-cross-process.test.ts", "tests/workflow-progress-fence.test.ts"],
} satisfies Declaracao;
