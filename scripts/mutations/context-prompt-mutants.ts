// Catálogo de dado puro da fatia `context-window` (issue #646, sub-issue A1
// de #637): mutantes de doutrina (`src/context/doctrine.ts`), moldura de
// memória/perfil/instruções e nota de snapshot (`src/context/
// system-prompt.ts`), snapshot de git (`src/context/discovery.ts`) e as
// seções verbatim/truncamento de cauda do resumo (`src/agent/aux.ts`,
// `src/conversation/compaction.ts`) — nenhum desses arquivos tinha mutante
// em nenhuma fatia até aqui (achado de #637: cinco issues de prompt em M22
// mergeadas sem mutante nenhum sobre o código novo).
//
// Arquivo separado de `context-window.ts` (não um `Files` que autorizasse
// crescer aquele arquivo além do teto de 800 linhas) — o runner de
// `context-window.ts` concatena os dois catálogos em `main()`. Dado puro
// (`export const contextPromptMutants`), sem `main()` de topo: seguro para
// `import` estático em `tests/mutations-slices.test.ts` e
// `tests/mutations-t23-catalog.test.ts`, mesmo padrão de
// `scripts/mutations/supervision-mutants.ts`.
import type { Mutant } from "./types.js";

const doctrine = "src/context/doctrine.ts";
const systemPrompt = "src/context/system-prompt.ts";
const discovery = "src/context/discovery.ts";
const aux = "src/agent/aux.ts";
const compaction = "src/conversation/compaction.ts";

const doctrineTests = "tests/context-doctrine.test.ts";
const contextTests = "tests/context.test.ts";
const discoveryTests = "tests/context-discovery.test.ts";
const auxContractTests = "tests/client-pool-aux.test.ts";
const compactionVerbatimTests = "tests/conversation-compaction-verbatim.test.ts";

export const contextPromptMutants: readonly Mutant[] = [
  // --- src/context/doctrine.ts (issue #579) -------------------------------
  {
    id: "doctrine-override-ignored",
    category: "doctrine",
    mechanism:
      "resolveDoctrineTier para de honrar LOHRA_DOCTRINE — o override de ambiente de maior precedência nunca vence mais, mesmo com um valor válido",
    focus: { file: doctrineTests, test: "LOHRA_DOCTRINE=core overrides an extended default" },
    edits: [
      {
        file: doctrine,
        before: '  if (override !== undefined && override !== "") {\n',
        after: "  if (false) {\n",
      },
    ],
  },
  {
    id: "doctrine-invalid-value-silent-fallback",
    category: "doctrine",
    mechanism:
      "resolveDoctrineTier para de falhar fechado num LOHRA_DOCTRINE inválido — em vez de lançar (invariante 2), cai silenciosamente no default por perfil",
    focus: {
      file: doctrineTests,
      test: "fails closed on an invalid LOHRA_DOCTRINE instead of silently falling back",
    },
    edits: [
      {
        file: doctrine,
        before:
          "    throw new Error(\n" +
          '      `LOHRA_DOCTRINE: valor inválido "${override}" (esperado "core" ou "extended")`,\n' +
          "      { cause: { LOHRA_DOCTRINE: override } },\n" +
          "    );\n",
        after: '    return CORE_ONLY_PROVIDERS.has(input.providerName) ? "core" : "extended";\n',
      },
    ],
  },
  {
    id: "doctrine-core-only-providers-emptied",
    category: "doctrine",
    mechanism:
      "CORE_ONLY_PROVIDERS fica vazio — ollama, o próprio exemplo de 'modelo pequeno' do épico #575, para de cair em core por default",
    focus: {
      file: doctrineTests,
      test: "defaults ollama — the epic's own 'small model' example — to core",
    },
    edits: [
      {
        file: doctrine,
        before:
          'const CORE_ONLY_PROVIDERS: ReadonlySet<string> = Object.freeze(new Set(["ollama"]));\n',
        after:
          "const CORE_ONLY_PROVIDERS: ReadonlySet<string> = Object.freeze(new Set<string>([]));\n",
      },
    ],
  },
  {
    id: "doctrine-text-extended-drops-extension",
    category: "doctrine",
    mechanism:
      "doctrineText('extended') devolve só DOCTRINE_CORE — a faixa 'extended' para de anexar DOCTRINE_EXTENDED, mesmo texto de qualquer tier",
    focus: {
      file: doctrineTests,
      test: "appends the extension after the core for tier 'extended'",
    },
    edits: [
      {
        file: doctrine,
        before:
          '  return tier === "extended" ? `${DOCTRINE_CORE}\\n\\n${DOCTRINE_EXTENDED}` : DOCTRINE_CORE;\n',
        after: "  return DOCTRINE_CORE;\n",
      },
    ],
  },
  // --- src/context/system-prompt.ts (issue #579/#582/#588) ----------------
  {
    id: "system-prompt-doctrine-dropped",
    category: "system-prompt",
    mechanism:
      "buildSystemPrompt para de incluir inputs.doctrine na faixa stable — a doutrina nunca chega ao prompt, mesmo quando o chamador a passa",
    focus: {
      file: contextTests,
      test: "places doctrine in the stable band, after identity and before Environment (issue #579)",
    },
    edits: [
      {
        file: systemPrompt,
        before: '    inputs.doctrine ?? "",\n',
        after: '    "",\n',
      },
    ],
  },
  {
    id: "system-prompt-memory-prefix-dropped",
    category: "system-prompt",
    mechanism:
      "buildSystemPrompt para de anteceder <memory> com MEMORY_PREFIX — o bloco de memória perde a moldura de autoridade/atualidade (issue #582)",
    focus: {
      file: contextTests,
      test: "prefixes <memory> with what it is and that it may be stale",
    },
    edits: [
      {
        file: systemPrompt,
        before:
          "      ? `${MEMORY_PREFIX}${SEPARATOR}<memory>\\n${inputs.memorySnapshot}\\n</memory>`\n",
        after: "      ? `<memory>\\n${inputs.memorySnapshot}\\n</memory>`\n",
      },
    ],
  },
  {
    id: "system-prompt-user-profile-prefix-dropped",
    category: "system-prompt",
    mechanism:
      "buildSystemPrompt para de anteceder <user-profile> com USER_PROFILE_PREFIX — o bloco de perfil perde a moldura de quem é o usuário (issue #582)",
    focus: {
      file: contextTests,
      test: "prefixes <user-profile> with who it describes",
    },
    edits: [
      {
        file: systemPrompt,
        before:
          "      ? `${USER_PROFILE_PREFIX}${SEPARATOR}<user-profile>\\n${inputs.userProfile}\\n</user-profile>`\n",
        after: "      ? `<user-profile>\\n${inputs.userProfile}\\n</user-profile>`\n",
      },
    ],
  },
  {
    id: "system-prompt-project-instructions-prefix-dropped",
    category: "system-prompt",
    mechanism:
      "contextText para de anteceder o grupo de context-files com PROJECT_INSTRUCTIONS_PREFIX — as instruções de projeto perdem a moldura de precedência sobre o comportamento default (issue #582)",
    focus: {
      file: contextTests,
      test: "prefixes the project instruction files once, before the whole group",
    },
    edits: [
      {
        file: systemPrompt,
        before:
          '  return rendered ? `${PROJECT_INSTRUCTIONS_PREFIX}${SEPARATOR}${rendered}` : "";\n',
        after: '  return rendered ? `${rendered}` : "";\n',
      },
    ],
  },
  {
    id: "system-prompt-snapshot-note-dropped",
    category: "system-prompt",
    mechanism:
      "environmentText para de anexar ENVIRONMENT_SNAPSHOT_NOTE — o bloco Environment: perde o aviso de que o snapshot foi tirado uma vez, no início da sessão (issue #588)",
    focus: {
      file: contextTests,
      test: "appends the snapshot note when at least one environment hint is present",
    },
    edits: [
      {
        file: systemPrompt,
        before: '  return `Environment:\\n${lines.join("\\n")}\\n${ENVIRONMENT_SNAPSHOT_NOTE}`;\n',
        after: '  return `Environment:\\n${lines.join("\\n")}`;\n',
      },
    ],
  },
  // --- src/context/discovery.ts (issue #582/#588) -------------------------
  {
    id: "discovery-dedupe-disabled",
    category: "discovery",
    mechanism:
      "dedupeIdenticalContent devolve a lista de entrada sem agrupar — AGENTS.md e CLAUDE.md byte-idênticos voltam a duplicar o mesmo conteúdo no prompt (issue #582)",
    focus: {
      file: contextTests,
      test: "dedupes identical content into one entry with a composite label",
    },
    edits: [
      {
        file: discovery,
        before:
          '  return contentOrder.map((content) => [(labelsByContent.get(content) ?? []).join(" = "), content]);\n',
        after: "  return [...files];\n",
      },
    ],
  },
  {
    id: "discovery-git-timeout-widened",
    category: "discovery",
    mechanism:
      "GIT_TIMEOUT_MS sobe de 500ms para 30s — um comando git travado deixa de ser cortado a tempo, violando o orçamento de construção do prompt (invariante 1)",
    focus: {
      file: discoveryTests,
      test: "never throws and omits git_* keys when git times out (fail-open, bounded)",
    },
    edits: [
      {
        file: discovery,
        before: "const GIT_TIMEOUT_MS = 500;\n",
        after: "const GIT_TIMEOUT_MS = 30000;\n",
      },
    ],
  },
  {
    id: "discovery-git-status-cap-removed",
    category: "discovery",
    mechanism:
      "GIT_STATUS_MAX_LINES sobe de 20 para 1000 — o teto de truncamento do git_status deixa de valer para um working tree com muitos arquivos sujos",
    focus: { file: discoveryTests, test: "truncates git_status at 20 lines with a marker" },
    edits: [
      {
        file: discovery,
        before: "const GIT_STATUS_MAX_LINES = 20;\n",
        after: "const GIT_STATUS_MAX_LINES = 1000;\n",
      },
    ],
  },
  {
    id: "discovery-git-default-branch-keeps-remote-prefix",
    category: "discovery",
    mechanism:
      "gitDefaultBranch para de cortar o prefixo do remote — devolve 'origin/main' inteiro em vez de só 'main'",
    focus: {
      file: discoveryTests,
      test: "reports git_default_branch only when refs/remotes/origin/HEAD is set locally",
    },
    edits: [
      {
        file: discovery,
        before: "  const short = slash === -1 ? ref : ref.slice(slash + 1);\n",
        after: "  const short = ref;\n",
      },
    ],
  },
  // --- src/agent/aux.ts / src/conversation/compaction.ts (issue #584/#587) -
  {
    id: "aux-summary-user-asks-verbatim-dropped",
    category: "aux",
    mechanism:
      'SUMMARY_SYSTEM perde "Verbatim" da seção "User Asks, Verbatim" — uma compactação deixa de saber que os pedidos do usuário precisam sobreviver ao resumo ao pé da letra',
    focus: {
      file: auxContractTests,
      test: "asks for the two verbatim sections and the non-attribution rule, by text (issue #584)",
    },
    edits: [
      {
        file: aux,
        before: '  "Work; User Asks, Verbatim (every distinct request the user made, quoted " +\n',
        after: '  "Work; User Asks (every distinct request the user made, quoted " +\n',
      },
    ],
  },
  {
    id: "aux-summary-constraints-verbatim-dropped",
    category: "aux",
    mechanism:
      'SUMMARY_SYSTEM perde "Verbatim" da seção "Constraints And Prohibitions, Verbatim" — uma proibição do usuário deixa de ser marcada como texto que o resumo precisa preservar exatamente',
    focus: {
      file: auxContractTests,
      test: "asks for the two verbatim sections and the non-attribution rule, by text (issue #584)",
    },
    edits: [
      {
        file: aux,
        before:
          '  "exactly, never paraphrased); Constraints And Prohibitions, Verbatim (every " +\n',
        after: '  "exactly, never paraphrased); Constraints And Prohibitions (every " +\n',
      },
    ],
  },
  {
    id: "compaction-transcript-truncation-keeps-tail-not-head",
    category: "compaction",
    mechanism:
      "buildTranscript passa a manter a CAUDA das mensagens dobradas em vez da CABEÇA quando o transcript excede o orçamento — o pedido/proibição mais antigo, exatamente o que o corte alinhado à cabeça existe para proteger, é o primeiro a ser descartado",
    focus: {
      file: compactionVerbatimTests,
      test: "cuts from the tail at the nearest turn boundary once the transcript exceeds the budget, keeping the head (and an early prohibition in it) intact",
    },
    edits: [
      {
        file: compaction,
        before: "  const kept = messages.slice(0, keepCount);\n",
        after: "  const kept = messages.slice(messages.length - keepCount);\n",
      },
    ],
  },
];
