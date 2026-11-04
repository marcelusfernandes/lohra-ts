// Issue #957 (épico #899, ADR 0006; decisão do owner na #947): um diretório e
// um destino que já existiam são aceitos no Windows quando só herdam o usuário,
// SYSTEM e Administradores, e a recusa de outra identidade diz quem é e o que
// fazer. `windows-heranca-aprovada.test.ts` prova, com operações injetadas, qual
// verificação cada objeto recebe (a estrita para o que o Lohra cria ou protege,
// a de preexistente só para o que já existia) e que a gravação não gasta
// processo a mais, a renovação do OAuth (`writeTokens`) pelo mesmo caminho, e o
// mecanismo real em pastas descartáveis (aceita, lista as identidades, e mantém
// Deny, dono, reparse point). `windows-acl-batch.test.ts` mantém a verificação
// estrita que `protect` aplica, e `windows-auth-protection.test.ts` a sequência
// inteira de uma gravação de credencial.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/windows-heranca-aprovada.test.ts",
    "tests/windows-acl-batch.test.ts",
    "tests/windows-auth-protection.test.ts",
  ],
} satisfies Declaracao;
