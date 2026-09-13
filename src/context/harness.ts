// Issue #580 (épico #575, P4): o bloco `Harness:` — o que ESTE runtime faz
// sozinho e o que não faz, por superfície e modo de execução. Distinto de
// `doctrine.ts` (#579): a doutrina fala do comportamento esperado do MODELO;
// este arquivo fala do MECANISMO do harness, e é por isso que vive num
// módulo separado — `tests/context-doctrine.test.ts` proíbe justamente as
// palavras que este texto precisa usar ("approval", "ask the user").
//
// Toda frase aqui tem de ser verdadeira contra o código HOJE, citado abaixo:
// - nenhum modo pede aprovação humana de comando (`src/tools/terminal.ts:86`:
//   "No mode of this runtime prompts a human for approval"; `chat.ts:331-332`
//   força o callback para `() => "deny"` em headless e para `null` em
//   interactive, e `ApprovalManager.require()` nega quando o callback é
//   `null` — `src/tools/approval.ts:91-93,102-103` — então a negação
//   automática e final vale em TODO modo, não só headless/server/subagent);
// - `--yolo` (só existe em `CHAT_SPEC`, `src/cli/arg-spec.ts:58`) é a ÚNICA
//   exceção — `ApprovalManager.require()` deixa passar quando `#yolo` está
//   ligado (`approval.ts:92`); dashboard e serve nunca chamam
//   `approval.setYolo` (grep confirmado), então essa exceção só existe para
//   uma sessão de `chat` explicitamente marcada;
// - até 8 tool calls independentes rodam em paralelo por turno, na ordem de
//   envio (`src/conversation/runtime.ts:637`, `runBounded(response.toolCalls,
//   8, …)`) — mecanismo compartilhado por `ConversationRuntime.runTurn`, que
//   é o mesmo motor por trás de chat, dashboard, `CompletionService` (serve)
//   e do child-runner do subagente;
// - toda tool embutida (`src/tools/envelope.ts`) devolve uma linha de JSON
//   `{"ok":true,…}` ou `{"error":…}` — `read_file`/`write_file`
//   (`src/tools/filesystem.ts`), `terminal.ts`, `web_fetch`/`web_search`
//   (`src/web/tool.ts`) e as tools MCP (`src/mcp/tools.ts:92,94`) passam
//   todas pelo mesmo envelope;
// - a história pode ser compactada num resumo, no lugar, por
//   `preflightCompact` (`runtime.ts`) — mas só quando o repositório da sessão
//   suporta `acquireCompressionLock`/`releaseCompressionLock`/
//   `compactHistory`; `RequestRepository` (`src/server/request-repository.ts`,
//   usado por `CompletionService`/`serve`) não implementa nenhum dos três, e
//   `preflightCompact` emite `compaction.unsupported` e segue sem compactar
//   nesse caso — por isso a linha de compactação NUNCA entra no modo
//   `"server"`; `ChildConversationRepository` (subagente) delega os três
//   métodos ao repositório SQLite do pai, então o subagente compacta como
//   chat/dashboard;
// - um `<system-reminder>` literal só existe hoje em
//   `src/orchestration/steer-inbox.ts:14` (`wrapSteerInbox`), drenado no
//   turno de um FILHO steerado (`src/orchestration/core.ts:433`) — a frase
//   abaixo é deliberadamente condicional ("se você ver um bloco…") para
//   continuar verdadeira em todo modo mesmo onde o mecanismo nunca dispara.
//
// Não hoje mencionado: sandbox de sistema de arquivos ou de rede. Não existe
// — `readFileTool`/`writeFileTool` (`src/tools/filesystem.ts`) resolvem
// qualquer caminho, sem raiz de confinamento, e `serve.ts` avisa o operador
// em texto que as tools "are NOT sandboxed" quando expostas por HTTP
// (`src/commands/serve.ts:104-106`). Prometer uma raiz de trabalho ou uma
// política de egress aqui seria falso; a lista original da issue #580
// ("sandbox: raiz de trabalho, egress") não tem oracle no código e por isso
// não vira frase.

/**
 * As quatro portas de entrada deste runtime hoje: `chat` sob `--json`/
 * `--no-input` (sem humano observando em tempo real), `chat`/`dashboard`
 * interativos (um humano pode estar lendo o streaming, mas sem canal de
 * pergunta mesmo assim), `serve` (turno aberto por uma requisição HTTP ao
 * gateway) e `subagent` (filho isolado, spawnado por `delegate_task` ou por
 * um node de workflow).
 */
export type PromptMode = "headless" | "interactive" | "server" | "subagent";

export interface HarnessTextInput {
  readonly mode: PromptMode;
  /**
   * `true` só quando a sessão de `chat` ativa rodou com `--yolo`
   * (`src/tools/approval.ts`'s `ApprovalManager#setYolo`) — a única exceção
   * real à negação automática. Ausente/`false` em todo outro caso, inclusive
   * `"subagent"`: o filho hoje herda o singleton global de `approval.ts` (não
   * há uma instância por sessão), então uma sessão pai com `--yolo` VAZA essa
   * mesma permissão para o filho — mas essa fiação vive em
   * `orchestration/chat-wiring.ts` e `child-runner.ts`, fora dos `Files`
   * desta issue (#580). Manter este parâmetro `false` por default para
   * `"subagent"` SUBESTIMA o que o filho pode realmente fazer sob um pai
   * `--yolo` (nunca o contrário) — o texto errado seguro é o que promete de
   * menos, não o que promete de mais. #583 (P7, prompt do subagente) é quem
   * tem `Files` para threadar o valor real.
   */
  readonly yolo?: boolean;
}

const NO_QUESTION_CHANNEL =
  "No mode of this harness lets you pause mid-turn to ask a question and " +
  "wait for a reply — there is no such channel anywhere in it. Decide with " +
  "what this turn already gives you.";

function presenceLine(mode: PromptMode): string {
  switch (mode) {
    case "headless":
      return (
        "Harness: this is a headless run (`--json` or `--no-input`) — " +
        "nobody is watching it in real time, and nobody will see partial " +
        "output as you go."
      );
    case "interactive":
      return (
        "Harness: a human may be reading this turn as it streams, but that " +
        "does not change what any tool does or how a denied command is " +
        "handled."
      );
    case "server":
      return (
        "Harness: this turn was opened by an HTTP request to the gateway " +
        "— you cannot tell from here whether a person or another program " +
        "is waiting on the reply."
      );
    case "subagent":
      return (
        "Harness: you are a subagent — no user is watching this turn, and " +
        "only the parent that spawned you will ever read your final " +
        "summary."
      );
    default: {
      const exhaustive: never = mode;
      throw new Error(`harnessText: unknown PromptMode: ${String(exhaustive)}`);
    }
  }
}

function denialLine(yolo: boolean): string {
  return yolo
    ? "`--yolo` is set for this session: the dangerous-command policy is " +
        "bypassed, and a command that would otherwise be refused runs " +
        "instead — nothing here double-checks it first."
    : "A command matching a fixed list of dangerous patterns (recursive " +
        "delete, force push, sudo, raw disk writes, and similar) is refused " +
        "automatically before it runs. That refusal is the policy itself, " +
        "not a person choosing to decline — it is final for this session; " +
        "report the blocked step plainly instead of retrying the same " +
        "command reworded.";
}

const PARALLEL_LINE =
  "Independent tool calls can go in the same response — the harness runs " +
  "up to 8 of them in parallel and returns their results in the same order " +
  "you sent them, so there is no need to wait for one call before issuing " +
  "the next independent one.";

const ENVELOPE_LINE =
  'Every tool result comes back as one line of JSON: `{"ok":true,...}` on ' +
  'success or `{"error":...}` on failure. An `error` field is information ' +
  "about what happened, not an instruction to keep trying — read it, then " +
  "decide whether to change approach, report the blocker, or continue.";

const COMPACTION_LINE =
  "Your conversation history can be compacted into a summary in place once " +
  "it grows too large for the model's context window. That is transparent " +
  "maintenance, not a reset or a new session — continue the task from " +
  "where you left off.";

const REMINDER_LINE =
  "If a message ever carries a `<system-reminder>` block, it came from the " +
  "operator or the harness itself, never from whoever is providing the " +
  "user's own turns.";

/**
 * Texto do bloco `Harness:` para um modo — `buildSystemPrompt` (issue #580)
 * o posiciona na faixa `stable`, depois da doutrina (#579) e antes de
 * `Environment`. Varia só nas linhas que dependem do modo (`presenceLine`,
 * a presença/ausência de `COMPACTION_LINE`) ou do `yolo` (`denialLine`) —
 * todo o resto é byte-idêntico entre chamadas.
 */
export function harnessText(input: HarnessTextInput): string {
  const yolo = input.yolo ?? false;
  const paragraphs = [
    presenceLine(input.mode),
    NO_QUESTION_CHANNEL,
    denialLine(yolo),
    PARALLEL_LINE,
    ENVELOPE_LINE,
    ...(input.mode === "server" ? [] : [COMPACTION_LINE]),
    REMINDER_LINE,
  ];
  return paragraphs.join("\n\n");
}
