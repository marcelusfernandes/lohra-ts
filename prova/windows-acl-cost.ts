// Issue #942 (épico #899): salvar uma credencial no Windows abre menos
// processos `powershell.exe` sem tirar nenhuma verificação. `protect` já
// verifica, então nada o repete logo depois; o volume viaja junto da primeira
// verificação; o script lê ACL por .NET e não carrega módulo (sem CLIXML).
// `windows-acl-batch.test.ts` prova o contrato do lote, os passos (viagens) com
// operações injetadas, a estrutura do script que garante que `protect` verifica
// (as conferências ficam depois do bloco do protect) e o mecanismo real em
// pastas descartáveis no Windows; `windows-file-protection.test.ts` mantém o
// contrato por operação; `windows-auth-protection.test.ts` prova a sequência
// inteira de uma gravação de credencial, conferência por conferência.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/windows-acl-batch.test.ts",
    "tests/windows-file-protection.test.ts",
    "tests/windows-auth-protection.test.ts",
  ],
} satisfies Declaracao;
