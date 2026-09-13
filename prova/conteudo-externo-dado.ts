// Issue #581 (épico #575, P5): conteúdo externo é dado, não instrução. O
// que este slug prova (AC da issue): DOCTRINE_CORE trata conteúdo devolvido
// por web/MCP/arquivo/skill como dado; web_fetch, web_search e todo
// resultado MCP carregam "untrusted": true no envelope de sucesso, chaves
// existentes intocadas; read_file e skill_view marcam o mesmo campo para um
// caminho/skill fora do project_root (rodada 1b: SkillTool.view liberado em
// src/tools/stateful.ts); as quatro descriptions embutidas e o wrapper MCP
// citam a mesma frase de aviso; o caso de eval de injeção prende os dois
// oráculos de mecanismo.
//
// A issue cita `tests/web-tool.test.ts`, que não existe neste repositório
// — `webFetchHandler`/`webSearchHandler` (`src/web/tool.ts`) são testados em
// `tests/web-tool-chat.test.ts` (comentário na issue #581).
import type { Declaracao } from "../scripts/prova/tipos.js";

export default {
  unit: [
    "tests/context-doctrine.test.ts",
    "tests/web-tool-chat.test.ts",
    "tests/mcp-tools.test.ts",
    "tests/tools-local.test.ts",
    "tests/tools-stateful.test.ts",
    "tests/tools-untrusted-content-notice.test.ts",
    "tests/builtin-definitions-budget.test.ts",
    "tests/eval-cases.test.ts",
  ],
} satisfies Declaracao;
