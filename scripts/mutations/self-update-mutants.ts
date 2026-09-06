// Catálogo de mutantes de `src/` que sobrevivem à triagem do agregador de
// closeout do diretório histórico de paridade (issue #153, passo 0f do
// épico #13). Preserva `id`/`before`/`after` byte a byte -- só o oráculo
// muda: em vez de rodar cada script de verificação do agregador antigo num
// subprocesso com o workspace do oracle Python injetado, cada mutante agora
// morre por um teste focado em `tests/**` (o mesmo `{file, test}` que os
// outros catálogos migrados usam via `runFocusedVitest`). Dois mutantes
// (`T22-updater-shell`, `T22-updater-host-cwd`) e um terceiro que faltava
// cobertura de comportamento (`T22-hotspot-workflow-handler`) e outro
// (`T22-l22-promotion-reopened`) não tinham teste que exercitasse o
// comportamento em si -- só o texto-fonte era pinado em
// `tests/t22-closeout.test.ts`, o que não prova nada sobre o runtime. Os
// quatro ganharam teste novo (`tests/self-update.test.ts`,
// `tests/gateway/session-service.test.ts`, `tests/session-tools.test.ts`).
//
// Nenhum símbolo aqui depende de I/O; só dados.
import type { Mutant } from "./types.js";

const repo = "src/self-update/repo.ts";
const service = "src/self-update/service.ts";
const terminal = "src/tools/terminal.ts";
const mcpManager = "src/mcp/manager.ts";
const sessionService = "src/gateway/session-service.ts";
const sessionTools = "src/commands/session-tools.ts";

const selfUpdateFocus = "tests/self-update.test.ts";

export const mutants: readonly Mutant[] = [
  {
    id: "T22-updater-shell",
    category: "updater-shell",
    mechanism: "family-a",
    focus: {
      file: selfUpdateFocus,
      test: "runs the subprocess with shell:false, so each argument is passed literally",
    },
    edits: [{ file: repo, before: "    shell: false,", after: "    shell: true," }],
  },
  {
    id: "T22-updater-non-ff",
    category: "updater-non-ff",
    mechanism: "family-a",
    focus: {
      file: selfUpdateFocus,
      test: "reports changed files and requests npm reinstall for dependency manifests",
    },
    edits: [{ file: service, before: '["pull", "--ff-only"]', after: '["pull"]' }],
  },
  {
    id: "T22-updater-divergence-after-pull",
    category: "updater-divergence-after-pull",
    mechanism: "family-a",
    focus: {
      file: selfUpdateFocus,
      test: "refuses structural divergence before pull and classifies a later pull failure",
    },
    edits: [
      {
        file: service,
        before: "      if (ahead.code === 1) {",
        after: "      if (ahead.code === 0) {",
      },
    ],
  },
  {
    id: "T22-updater-host-cwd",
    category: "updater-host-cwd",
    mechanism: "family-a",
    focus: {
      file: selfUpdateFocus,
      test: "resolves the installed repo from the module's own location, not the process cwd",
    },
    edits: [
      {
        file: service,
        before: "locateRepo(dirname(fileURLToPath(moduleUrl)))",
        after: "locateRepo(process.cwd())",
      },
    ],
  },
  {
    id: "T22-node-pty-bypass",
    category: "node-pty-bypass",
    mechanism: "family-a",
    focus: {
      file: "tests/tools-local.test.ts",
      test: "returns stdout, stderr and nonzero exits",
    },
    edits: [
      {
        file: terminal,
        before: "child = spawnPty(invocation.executable, [...invocation.args], {",
        after: "child = spawnPty(process.execPath, [...invocation.args], {",
      },
    ],
  },
  {
    id: "T22-mcp-last-wins",
    category: "mcp-last-wins",
    mechanism: "family-a",
    focus: {
      file: "tests/mcp-manager.test.ts",
      test: "rejects a sanitized cross-server collision in either declaration order with no partial publication",
    },
    edits: [
      {
        file: mcpManager,
        before:
          "        if (seen.has(registration.name)) throw new MCPToolNameCollisionError(registration.name);",
        after: "        if (seen.has(registration.name)) continue;",
      },
    ],
  },
  {
    id: "T22-l22-promotion-reopened",
    category: "l22-promotion-reopened",
    mechanism: "family-a",
    focus: {
      file: "tests/gateway/session-service.test.ts",
      test: "is false for an orchestration-owned subsession, even after session.create makes it known",
    },
    edits: [
      {
        file: sessionService,
        before: '      return "subsession";',
        after: "      return null;",
      },
    ],
  },
  {
    id: "T22-hotspot-workflow-handler",
    category: "hotspot-workflow-handler",
    mechanism: "family-a",
    focus: {
      file: "tests/session-tools.test.ts",
      test: "wires run_workflow to the real WorkflowService, not the fail-safe placeholder",
    },
    edits: [
      {
        file: sessionTools,
        before:
          "    ...workflowToolHandlers(options.workflowService, options.base.auditRepository),",
        after: "    ...{},",
      },
    ],
  },
];
