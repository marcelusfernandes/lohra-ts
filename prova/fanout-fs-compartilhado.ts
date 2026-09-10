// Declaração de prova da issue #248: fan-out sobre working root
// compartilhado — teste de contenção (último escritor vence, silenciosamente,
// quando duas branches escrevem o mesmo arquivo; arquivos diferentes são
// seguros) e a asserção de que a descrição de `run_workflow` traz a doutrina
// "um arquivo por folha, agregação a jusante".
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/workflow-sandbox.test.ts"],
} satisfies Declaracao;
