// Issue #960 (épico #899, ADR 0006): o ramo que aceita a herança de um objeto
// preexistente (`Assert-Preexisting` e o ponto de chamada, no `ACL_SCRIPT`) fica
// preso por teste no CI Linux obrigatório. `windows-heranca-ancora.test.ts` lê o
// texto do script, sem executá-lo, e prende a posição e a forma de cada conferência
// (dono, DACL vazia, Deny, identidades aprovadas, lista de recusa, controle total) e
// a chamada só com a flag; roda em qualquer sistema operacional. O mecanismo real
// segue em `windows-heranca-aprovada.test.ts` e as conferências estritas em
// `windows-acl-batch.test.ts`, que esta prova não repete.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/windows-heranca-ancora.test.ts"],
} satisfies Declaracao;
