// Issue #942 (épico #899): salvar uma credencial no Windows abre menos
// processos `powershell.exe` sem tirar nenhuma verificação. `protect` já
// verifica, então nada o repete logo depois; o volume viaja junto da primeira
// verificação; o script lê ACL por .NET e não carrega módulo (sem CLIXML).
// `windows-file-protection.test.ts` prova o contrato do lote, os passos
// (viagens) com operações injetadas e o mecanismo real em pastas descartáveis
// no Windows; `windows-auth-protection.test.ts` prova a sequência inteira de
// uma gravação de credencial, conferência por conferência.
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: ["tests/windows-file-protection.test.ts", "tests/windows-auth-protection.test.ts"],
} satisfies Declaracao;
