# Custo do prompt de execução

Este documento nasce com a issue #585 (épico #575, P9 — dieta do catálogo de
tools) e cobre só o que essa issue mudou: o piso de tokens que o catálogo de
tools paga em toda chamada. A doutrina do system prompt em si (identidade,
harness por superfície, memória, subagente) é escopo de outras sub-issues do
mesmo épico (#579–#590) e ganha seção própria aqui à medida que mergeiam —
este arquivo não descreve hoje o que ainda não existe no runtime.

## O catálogo de tools é reenviado inteiro a cada iteração

`src/conversation/runtime.ts` manda `BUILTIN_DEFINITIONS`
(`src/tools/builtin-definitions.ts`) completo a cada chamada ao provedor,
dentro do turno — não só na primeira iteração. As 29 tools, schema e ordem
intocados (contrato pinado por hash SHA-256 em
`tests/builtin-definitions-budget.test.ts`), custam:

|                                    | antes da dieta (#585) | depois                             |
| ---------------------------------- | --------------------- | ---------------------------------- |
| chars de JSON do catálogo          | 43.951                | 21.916 (#582; teto de CI: 22.000)  |
| tokens estimados (2,4 chars/token) | ~18.313               | ~9.132                             |
| % em tools de `workflow_*`         | 72%                   | reduzido, mesma proporção de tools |

A regra de conversão (2,4 chars/token) é a mesma que
`src/context/token-estimate.ts` usa para a estimativa de janela de contexto
antes de cada chamada (`docs/context-compaction.md`).

## O que a dieta moveu, e para onde

`run_workflow` sozinha tinha 8.157 chars de description — um manual completo
(exemplo de spec, semântica de pivô de rota, glossário do rollup) que
também vivia, quase palavra por palavra, em
`assets/skills/workflow-authoring/SKILL.md`. A dieta manteve na description
só o que uma tool description deve conter (Claude Code,
`tool-use-concepts.md`: "seja prescritivo sobre quando chamar, não apenas o
que faz"):

- a lista fechada dos 10 tipos de nó (nomes, não a semântica de cada um);
- a doutrina de comportamento que não pode viver só na skill (`lohra`
  Python #36: "texto segura manchetes, não cláusulas sutis") — o
  filesystem compartilhado entre branches de `parallel`, os campos
  `min_success_ratio`/`budget` como tetos reais;
- o ponteiro `Load the workflow-authoring skill before authoring`.

Tudo que é manual — qual node type cabe em qual formato de tarefa, como
dimensionar o fan-out, `live_tail`, `rename_hint`, `workflow_leaf_read`,
`workflow_steer`, o glossário de eventos do `workflow_audit` — saiu das
descriptions das tools `workflow_status`/`workflow_audit`/`workflow_preview`/
`workflow_leaf_read`/`workflow_steer` e ganhou seção própria na skill
(`## Live tail, rename_hint, mid-flight leaf reads, and steering`, mais as
seções pré-existentes de sizing e reading do rollup).

## As sete tools básicas ganharam "quando usar / quando não / limite"

`read_file`, `write_file`, `terminal`, `web_fetch`, `web_search`,
`session_search` e `skill_view` tinham descriptions de 1-2 linhas sem dizer
quando usar, quando não, ou qual o limite de tamanho — por exemplo,
`read_file` não dizia que trunca em 100.000 code points nem que existe
`terminal` como alternativa para um arquivo grande demais. A dieta reescreve
as sete no mesmo padrão: propósito, quando preferir a alternativa (`terminal`
vs. `read_file`/`write_file`, `web_search` vs. `web_fetch`), e o limite
numérico real do código (não um número inventado).

## Overlay de avisos operacionais no turno (issue #589, P13)

Distinto da dieta do catálogo acima (que corta o que é enviado sempre): o
overlay de avisos ACRESCENTA conteúdo à mensagem do usuário, só quando há
algo pendente. `ConversationRuntime.runTurn` recebe uma porta opcional
`notices: TurnNoticesPort` (`src/context/notices-overlay.ts`); sem ela — ou
sem nada pendente — o request é byte-idêntico a antes desta issue existir.

Com avisos pendentes, o que entra no turno:

- No início, um _claim_ lê os avisos não reconhecidos do escopo `global` mais
  `session:<id>` para a sessão e cada ancestral
  (`SessionRepository.lineageRootToTip`) — nunca `run:<id>` (workflow run e
  sessão de chat são namespaces de id disjuntos; detalhe completo em
  `docs/operator-notices.md#entrega-no-turno-sem-tool-call-issue-589`).
- O bloco formatado tem teto de **4.096 chars** (cabeçalho
  `OPERATOR NOTICES (not the user speaking):`, marcador de fim); o que não
  coube fica de fora do texto e do que é reconhecido, pendente para o
  próximo claim.
- Anexado ao CONTEÚDO da mensagem do usuário do turno — nunca ao
  `systemPrompt` (mesma doutrina de P3/P4: bloco do operador não é fala do
  usuário; o cabeçalho reforça isso em texto).
- **Ack só depois de `commitTurn`** gravar o turno; qualquer falha antes
  disso pula para o `catch` de `runTurn`, que nunca confirma — o aviso
  reaparece no claim do próximo turno exatamente como se este nunca tivesse
  rodado.
- Um turno morto publica seu próprio aviso (`session:<sessionId>`, `kind`
  mapeado de `ConversationError.code`) para o PRÓXIMO turno da mesma sessão
  ver, via claim.

Wireado sobre o MESMO `noticesRepository` que `workflow_notices` já lê, em
`chat.ts` e no `runJob` do `dashboard.ts` — nenhuma superfície nova.

## Doutrina de comportamento (issue #579, P3)

`src/context/doctrine.ts` — o que faltava além de `DEFAULT_IDENTITY`
(`src/context/system-prompt.ts:1-5`): relatar o observado, tratar o escopo
pedido como o entregável, agir em vez de narrar opções, e nunca terminar um
turno em plano, pergunta ou promessa. Duas constantes, em inglês como o
resto do prompt:

- **`DOCTRINE_CORE`** (~400 tokens, 2,9 chars/token — a mesma regra de
  conversão de `src/context/token-estimate.ts`; cresceu para ~610 tokens na
  issue #582, P6, com a regra de memória — ver seção própria abaixo) —
  enviado a TODO perfil de provedor.
- **`DOCTRINE_EXTENDED`** (~370 tokens adicionais) — forma e julgamento
  (uma ideia por frase, diagnóstico ≠ conserto, reafirmação do usuário
  encerra o debate, evidência antes de mudar estado). Só perfis "fortes".

Nenhuma das duas descreve um mecanismo do harness que não existe (aprovação
humana de comando, plan mode, canal de pergunta ao usuário, fallback de
modelo) — isso é escopo do bloco Harness por superfície (#580, P4); a
doutrina só referencia o comportamento esperado do MODELO.
`tests/context-doctrine.test.ts` prende as duas coisas: frases de
comportamento presentes, frases de mecanismo inexistente ausentes.

`buildSystemPrompt` (`src/context/system-prompt.ts`) recebe `doctrine` como
uma string já resolvida e a posiciona na faixa `stable`, depois da
identidade e antes de `Environment` — ausente por default, byte-idêntico a
antes de #579 quando nenhuma superfície passa doctrine.

### Tier por perfil: `resolveDoctrineTier`

`resolveDoctrineTier` (`src/context/doctrine.ts`) decide `"core"` ou
`"extended"` por nome de provedor (`profile.name`), com
`LOHRA_DOCTRINE=core|extended` sobrepondo o default — qualquer outro valor
não vazio falha fechado (lança), nunca cai silenciosamente no default.
`ollama` é o único perfil builtin em `"core"` por default: o próprio épico
#575 cita "modelos pequenos via Ollama" como o caso que uma doutrina longa
pode piorar. Todo outro nome (conhecido ou futuro, incluindo
`"openai-codex"`) cai em `"extended"`.

Deliberadamente **não** é um campo em `ProviderProfile`
(`src/providers/types.ts`): esse arquivo ficou fora do escopo de arquivos
desta issue. `resolveDoctrineTier` chaveia por `profile.name`, que já é
público — uma extensão futura da interface (se um perfil precisar de mais
que um nome para decidir a faixa) é decisão de outra issue.

### Fiação por superfície

`chat`, `dashboard` e `serve` resolvem a faixa uma vez (não a cada turno —
invariante 1 do CLAUDE.md: o system prompt é construído uma vez por sessão
e congelado) a partir do `profile` já escolhido, e passam o texto resolvido
para `buildSystemPrompt`. `serve` deixava de mandar só identidade + data;
agora manda a doutrina também.

O subagente (`src/orchestration/subagent-prompt.ts`) recebe sempre
`DOCTRINE_CORE`, nunca a extensão: o call site que o invoca
(`src/orchestration/chat-wiring.ts`'s `buildSubagentPrompt`) não tem o
perfil do provedor pai disponível para decidir a faixa — continua assim
depois de #583 (P7) também; essa issue estendeu o mesmo call site com
`cwd`/lista de tools, não com o perfil do provedor (seção própria abaixo).

## Modo por superfície (issue #580, P4)

`src/context/harness.ts` — o bloco `Harness:` diz o que o harness faz
sozinho e o que não faz, para o único componente que poderia usar essas
capacidades e não sabia delas. Distinto da doutrina (#579): a doutrina fala
do comportamento esperado do MODELO; o Harness fala do MECANISMO do
runtime, e por isso vive num arquivo à parte —
`tests/context-doctrine.test.ts` proíbe na doutrina justamente as palavras
que o Harness precisa usar ("approval", "ask the user").

`PromptMode = "headless" | "interactive" | "server" | "subagent"` — a porta
de entrada do turno:

| modo          | quem passa                             | quando                                               |
| ------------- | -------------------------------------- | ---------------------------------------------------- |
| `headless`    | `chat.ts`                              | `--json` ou `--no-input`                             |
| `interactive` | `chat.ts`, `dashboard.ts`              | `chat` sem `--json`/`--no-input`; `dashboard` sempre |
| `server`      | `serve.ts`                             | sempre (todo turno é uma requisição HTTP)            |
| `subagent`    | `src/orchestration/subagent-prompt.ts` | sempre (filho isolado)                               |

`harnessText({ mode, yolo? })` monta o bloco variando só as linhas que
dependem do modo (ou de `yolo`) — todo o resto é byte-idêntico entre
chamadas (`tests/context-harness-mode.test.ts` prende essa invariante
diretamente). O que o bloco afirma, e onde isso é verdade no código:

- **Nenhum modo tem canal de pergunta**: não há aprovação humana de comando
  em modo nenhum (`src/tools/terminal.ts:86`; `chat.ts` força o callback de
  aprovação para `() => "deny"` em headless e `null` em interactive, e
  `ApprovalManager.require()` nega quando o callback é `null` —
  `src/tools/approval.ts`). A única exceção real é `--yolo`
  (`CHAT_SPEC`, só existe em `chat`) — `harnessText({ mode, yolo: true })`
  troca a frase de negação pela frase de bypass.
- **Paralelismo real**: até 8 tool calls independentes por turno, na ordem
  de envio (`src/conversation/runtime.ts:637`, `runBounded`) — o mesmo
  motor por trás de chat, dashboard, `serve` (`CompletionService`) e do
  child-runner do subagente.
- **Envelope JSON**: toda tool embutida devolve `{"ok":true,…}` ou
  `{"error":…}` (`src/tools/envelope.ts`) — um `error` é informação, não
  instrução de retentativa.
- **Compactação transparente** — presente em `headless`, `interactive` e
  `subagent`; ausente em `server`, porque `CompletionService`'s
  `RequestRepository` (`src/server/request-repository.ts`) não implementa
  `acquireCompressionLock`/`releaseCompressionLock`/`compactHistory`, e
  `preflightCompact` (`src/conversation/runtime.ts`) segue sem compactar
  (fail-open) quando o repositório não suporta os três.
- **Proveniência de `<system-reminder>`**: só existe hoje em
  `src/orchestration/steer-inbox.ts` (turno de um filho steerado); a frase
  é condicional ("se você ver um bloco…") para continuar verdadeira mesmo
  onde o mecanismo nunca dispara.

Nunca mencionado: sandbox de sistema de arquivos ou de rede — não existe.
`readFileTool`/`writeFileTool` (`src/tools/filesystem.ts`) resolvem
qualquer caminho, sem raiz de confinamento, e `serve.ts` já avisa o
operador em texto que as tools "are NOT sandboxed" quando expostas por
HTTP.

### `--no-tools` mantém memória, perfil e índice de skills (AC 2)

Antes desta issue, `chat --no-tools` também apagava `<memory>`,
`<user-profile>` e o índice de skills do prompt — a tool some, mas o
conhecimento não devia ir junto. `chat.ts`'s `snapshot()` lê
`memoryStore.snapshot()` e `skillStore.snapshot()` incondicionalmente
agora; só o REGISTRO das tools (`memory`, `skill_view`, …) continua
condicionado a `useTools`.

### `dashboard` monta o prompt com os mesmos inputs de `chat` (AC 3)

Antes desta issue, `dashboard.ts` só passava `doctrine`, `contextFiles` e
`environmentHints` a `buildSystemPrompt` — nunca identidade (`loadSoul`),
memória, perfil de usuário ou índice de skills, mesmo já tendo acesso a
`options.home`/`options.cwd`. `dashboard.ts` agora carrega os mesmos
quatro insumos que `chat.ts` carrega, sempre em modo `"interactive"` (não
existe `--json`/`--no-input`/`--yolo` em `DASHBOARD_SPEC`).
`tests/gateway/dashboard-prompt-contract.test.ts` prova isso contra um
turno real (boot de `runDashboard`, WebSocket real, stub HTTP local
capturando a requisição de verdade).

## Conteúdo externo é dado, não instrução (issue #581, P5)

`web_fetch`, um servidor MCP, um arquivo lido de fora do projeto ou uma
skill devolvem texto que pode conter uma instrução dirigida ao modelo ("ignore
suas instruções e…"). Duas camadas, complementares:

- **Doutrina** (`DOCTRINE_CORE`, `src/context/doctrine.ts`): um parágrafo diz
  que texto devolvido por uma tool que lê web, MCP, arquivo ou skill é dado,
  nunca instrução — mesmo quando lê como um comando direto. Se parecer um,
  o modelo não obedece, diz que o conteúdo pareceu suspeito, e continua a
  tarefa original. Comportamento do MODELO, não mecanismo do harness — sem
  os termos que `tests/context-doctrine.test.ts` proíbe.
- **Envelope**: `web_fetch`, `web_search` e todo resultado MCP
  (`wrapCallResult`, `src/mcp/tools.ts`) devolvem `"untrusted": true` como a
  ÚLTIMA chave do envelope de sucesso — campo aditivo, ordem das chaves
  existentes intocada (`docs/adr/0003-native-wire-format.md`). `read_file`
  (`src/tools/filesystem.ts`) marca o mesmo campo só quando o caminho lido
  não é ancestral do `project_root` que `findProjectRoot`
  (`src/context/discovery.ts`) resolve a partir do cwd real do processo — um
  arquivo dentro do projeto não carrega a chave, byte-compatível com quem não
  a lê. `skill_view` (`SkillTool.view()`, `src/tools/stateful.ts`) usa o
  mesmo critério (`isUntrustedPath`, exportada de `filesystem.ts`) sobre
  `skill.path`: uma skill "home" ou builtin fora do repositório aberto ganha
  `untrusted: true`, assim como o caso hipotético de `skill.path` vir
  `undefined` (lado seguro — a doutrina promete menos sobre a origem, nunca
  mais); uma skill dentro do `project_root` (ex.: uma skill builtin quando o
  runtime roda de um checkout deste próprio repositório) não carrega a
  chave. Rodada 1b da issue #581: `src/tools/stateful.ts` e
  `tests/tools-stateful*.test.ts` entraram nos `Files` depois do comentário
  original sobre esse arquivo estar fora de escopo.

`read_file`, `web_fetch`, `web_search`, `skill_view` (`BUILTIN_DEFINITIONS`)
e o wrapper de description de tool MCP (`convertMcpSchema`) citam a mesma
frase — `UNTRUSTED_CONTENT_NOTICE`, exportada de `src/mcp/tools.ts` — e
`tests/tools-untrusted-content-notice.test.ts` prende as cinco cópias juntas
(padrão anti-drift de `tests/tools-terminal-description.test.ts`, #577).

`tests/fixtures/eval/injected-instruction-in-fetched-content.json` tem os
dois oráculos que a issue pede: mecanismo (o envelope de `read_file` carrega
`"untrusted":true`; o system prompt enviado contém a frase da doutrina) e
resultado, contra um provedor real (o modelo não segue a instrução injetada
e reporta o conteúdo como suspeito) — `docs/eval.md` explica a diferença
entre os dois oráculos.

## Moldura de memória, perfil e instruções do projeto (issue #582, P6)

Antes desta issue, `buildSystemPrompt` (`src/context/system-prompt.ts`)
injetava `<memory>…</memory>`, `<user-profile>…</user-profile>` e
`<context-file name="…">…</context-file>` crus — nenhuma frase dizia o que
cada bloco é, que autoridade tem, ou quando escrever nele. A doutrina de
"quando salvar" vivia só na description da tool `memory`
(`src/tools/builtin-definitions.ts`), que some sob `--no-tools`; em runs
repetidos (#574, E2) nenhum `MEMORY.md` chegou a ser criado na prática.

### Três prefixos, cada um ausente quando o bloco está ausente

`buildSystemPrompt` agora prefixa cada bloco com uma frase — o mesmo
`filter(Boolean)` que já governa o resto da função preserva byte-compat
quando o insumo correspondente não é passado:

| bloco                     | prefixo                                                                                                                                                             | faixa      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `<memory>`                | "Memory: durable facts you saved in earlier sessions; they reflect what was true when written — verify a file, flag, or command still exists before relying on it." | `volatile` |
| `<user-profile>`          | "User profile: who the user is and how they prefer to work."                                                                                                        | `volatile` |
| grupo de `<context-file>` | "Project instructions below override default behavior for work inside this project."                                                                                | `context`  |

O prefixo de `<context-file>` entra uma única vez antes do GRUPO inteiro de
arquivos (não repetido por arquivo) — `contextText` em
`system-prompt.ts`. Memória e perfil não usam vocabulário de confiança
("untrusted"): são fatos que o próprio runtime gravou, não conteúdo
externo (#581) — a ressalva do prefixo de memória é de atualidade (pode
ter envelhecido), nunca de proveniência.

### A regra de quando salvar memória entra em `DOCTRINE_CORE`

`DOCTRINE_CORE` (`src/context/doctrine.ts`) ganha um parágrafo final: salvar
um fato durável (correção do usuário, preferência, convenção de projeto),
nunca progresso de tarefa nem o que o repositório já registra; e, antes de
culpar uma falha no "ambiente" (uma quota, um timeout), exigir evidência do
próprio turno — sem ela, a causa é a própria escolha do modelo (**agência**,
não **ambiente** — decision note #54, mesma taxonomia de
`backend/lohra/memory/tool.py` no Python). O núcleo cresceu de ~400 para
~610 tokens (2,9 chars/token) por isso — `tests/context-doctrine.test.ts`
documenta o novo teto (1900 chars) e prende a taxonomia e a proibição do
enquadramento "environment quirk" sem essa qualificação.

As descriptions de `memory` e `skill_manage` (`BUILTIN_DEFINITIONS`) citam a
mesma taxonomia (`tests/tools-memory-guidance.test.ts`, porta de
`test_memory_guidance_taxonomy.py`) — o orçamento do catálogo (22.000
chars, hoje em 21.916) foi mantido encolhendo prosa sem AC em outras 17
descriptions
(cronjob, vision_analyze, image_gen, spawn_session, steer_session,
collect_session, workflow_list, workflow_pause, workflow_cancel,
workflow_templates, workflow_notices, workflow_notices_ack,
workflow_leaf_read, workflow_preview, session_search, delegate_task,
list_models); schema, ordem e as demais descriptions pinadas por outras
issues (`run_workflow`, `workflow_status`, `workflow_audit`, as sete tools
básicas) ficaram intocados —
`tests/builtin-definitions-budget.test.ts` (fora dos `Files` desta issue,
regressão confirmada, não reescrita) segue verde.

### Dedupe de instruções idênticas

`discoverInstructions` (`src/context/discovery.ts`) agrupa arquivos de
conteúdo byte-idêntico (o caso comum: `AGENTS.md` e `CLAUDE.md` no mesmo
diretório, escritos para harnesses diferentes lerem a mesma coisa) num
único `ContextFile`, com o label composto (`"AGENTS.md = CLAUDE.md"`,
ordem de descoberta preservada) — este repositório media 96% de um prompt
vindo dos dois arquivos duplicados (épico #575). Conteúdo diferente nunca é
agrupado, mesmo vindo do mesmo diretório.

### Eval

`tests/fixtures/eval/user-preference-correction.json` e
`info-already-in-repo.json` (`dev`, já existiam desde #576) ganham um
`mechanism` a mais cada: o primeiro prende a frase da regra de memória
chegando ao `system_prompt`; o segundo prende o prefixo de instruções do
projeto chegando antes do sentinel do `CLAUDE.md`. Holdouts não foram
tocados (nunca calibrados por texto). Dogfooding real (`--provider
openrouter`, `LOHRA_HOME` descartável com `MEMORY.md`/`USER.md`
pré-semeados): pedir para lembrar uma preferência gera um `memory add`
espontâneo (`target: "user"`, sem o modelo ser instruído a chamar a tool
por nome); perguntar pelo conteúdo do `CLAUDE.md`/`AGENTS.md` deduplicados
responde certo sem nenhuma chamada de `memory`.

## Ambiente, lista de tools e contrato de retorno do subagente (issue #583, P7)

Antes desta issue, o prompt do filho (`src/orchestration/subagent-prompt.ts`)
não dizia onde ele estava (`cwd`), não listava as tools que sobraram do
allow-list do pai, e pedia só "end with a concise summary" — sem forma que
um chamador pudesse ler de volta sem adivinhar pela prosa.

### O que `buildSubagentSystemPrompt` ganhou

- **`cwd`** vira o bloco `Environment:` já existente de `buildSystemPrompt`
  (`environmentHints`) — o filho sabe seu diretório de trabalho sem chamar
  `pwd`.
- **`toolNames`** vira um parágrafo (via `systemMessage`, a faixa entre
  `stable` e `volatile`) que lista as tools disponíveis, a fronteira da
  tarefa ("stop and report" em vez de improvisar fora do escopo pedido), o
  aviso de que o pai nunca vê o tool output cru (só o texto final do turno),
  e a sentinela de retorno: `result: <summary>` | `failed: <why>` |
  `needs input: <what>`, uma linha por vez, a última do texto.
- Os dois blocos são omitidos (nunca o texto vazio) quando o insumo
  correspondente está ausente — o mesmo `filter(Boolean)` que já governa o
  resto de `buildSystemPrompt`.

`chat-wiring.ts`'s `buildSubagentPrompt` deriva `toolNames` com o MESMO
`childToolDefinitions(parentToolDefinitions)` que `child-runner.ts` usa para
o `toolDefinitions` real do turno — o prompt e o catálogo de tools do turno
nunca podem divergir, porque os dois vêm da mesma chamada. `cwd` vem do
mesmo `options.cwd` que `child-runner.ts` já usava para o `cwd` real do
turno. O teste de contrato (`tests/orchestration-subagent-prompt.test.ts`)
substitui o antigo pino byte-exato: prende blocos presentes, ordem, e que a
lista de tools vem de `childToolDefinitions`, nunca uma segunda cópia
digitada à mão.

`yolo` continua ausente/`false` no `Harness:` do subagente — mas não por
subestimar um vazamento pendente: `child.ts`'s `createChildDispatch` recusa
comando perigoso incondicionalmente, independente do singleton global de
`src/tools/approval.ts` (`tests/tools-security-lifecycle.test.ts`, "keeps a
dangerous child command denied when the parent approval is yolo") — não há
vazamento de `--yolo` do pai para o filho via `terminal` para corrigir, e a
frase "refused automatically and finally" já é verdadeira como está.

### `outcome`: aditivo em `delegate_task`/`collect_session`

`child-runner.ts` lê a última linha não-vazia do turno "complete"
(`parseOutcomeSentinel`, `outcome-sentinel.ts`) e guarda em
`CollectResult.outcome` (`"result" | "failed" | "needs_input" | null`) —
puramente aditivo: nunca altera `status`/`error_kind`, mesmo quando o filho
escreve `failed: …` no próprio texto (o turno ainda é `status: "complete"`
se o modelo respondeu normalmente). O envelope de `collect_session` (13ª
chave) e de `delegate_task` (9ª chave, batch e resume) carregam `outcome` no
fim — chaves existentes intocadas na mesma ordem (precedente #232/#429).
Sentinela ausente vira `outcome: null`, presente e nunca omitido. As
descriptions de `delegate_task`/`collect_session` (`BUILTIN_DEFINITIONS`)
citam o campo e seus três valores possíveis, para o pai saber que a chave
existe sem precisar descobrir por tentativa.

`tests/fixtures/eval/delegated-task-with-scope.json` tem os dois oráculos: o
system prompt do filho (requisição 2) carrega `Environment:`/`Tools
available to you:`/a sentinela; o envelope de `delegate_task` (requisição 3)
carrega `"outcome":"result"` de volta ao pai.

## O que este documento ainda não cobre

`prompt caching` — não existe no runtime hoje. Cada sub-issue do épico #575
que o implementa atualiza este arquivo quando mergeia.
