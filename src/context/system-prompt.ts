import type { SystemBands } from "../transports/types.js";

export const DEFAULT_IDENTITY =
  "You are Lohra, a self-improving AI assistant. You are helpful, " +
  "knowledgeable, and direct. You use tools to take real action and you " +
  "never fabricate results — reporting a blocker honestly is always better " +
  "than inventing an outcome.";

const SEPARATOR = "\n\n";

/** Issue #582 (épico #575, P6): moldura para os três blocos que hoje
 * chegam crus (`<memory>`, `<user-profile>`, `<context-file>`) — uma frase
 * antes de cada um dizendo o que é e como usar, ausente quando o bloco está
 * ausente (mesmo `filter(Boolean)` que já governa o resto de
 * `buildSystemPrompt`, byte-compat preservado). Memória e perfil não usam
 * vocabulário de confiança ("untrusted") — são fatos que o próprio runtime
 * gravou, não conteúdo externo (issue #581); a ressalva aqui é de
 * atualidade (pode ter envelhecido), não de proveniência. */
const MEMORY_PREFIX =
  "Memory: durable facts you saved in earlier sessions; they reflect what " +
  "was true when written — verify a file, flag, or command still exists " +
  "before relying on it.";
const USER_PROFILE_PREFIX = "User profile: who the user is and how they prefer to work.";
const PROJECT_INSTRUCTIONS_PREFIX =
  "Project instructions below override default behavior for work inside this project.";

/** Issue #588 (épico #575, P12): última linha do bloco `Environment:` —
 * o snapshot (plataforma, shell, node, git) é tirado uma vez, no início da
 * sessão (invariante 1), e nunca se atualiza durante a conversa mesmo que
 * o estado real mude. Presente sempre que houver ao menos um hint. */
const ENVIRONMENT_SNAPSHOT_NOTE =
  "Snapshot taken at session start; it does not update during the conversation.";

/** Same join rule `SystemPromptSnapshot.text` below has always used, pulled
 * out so `systemPromptText` (issue #586) can reuse it byte-for-byte for a
 * caller that only has the three bands, never the constructed snapshot. */
function joinBands(bands: SystemBands): string {
  return [bands.stable, bands.context, bands.volatile].filter(Boolean).join(SEPARATOR);
}

export class SystemPromptSnapshot implements SystemBands {
  readonly stable: string;
  readonly context: string;
  readonly volatile: string;
  readonly text: string;

  constructor(stable: string, context: string, volatile: string) {
    this.stable = stable;
    this.context = context;
    this.volatile = volatile;
    this.text = joinBands(this);
    Object.freeze(this);
  }
}

/** Issue #586 (épico #575, 2ª rodada): flattens a `ModelRequest.system`/
 * `StoredSession.systemPrompt` value back to plain text for a consumer that
 * only ever bills/estimates a single string (`estimateRequestTokens`,
 * `estimatePartialUsage`, `src/context/token-estimate.ts` -- out of this
 * issue's `Files`), and also for `chat-completions.ts`/`responses.ts`
 * (neither has a per-block `cache_control`, so both flatten before
 * building their own kwargs). A bare string is returned as-is -- every
 * caller before this issue, and still every caller that only ever produces
 * a flattened prompt (e.g. the gateway WS session,
 * `src/gateway/session-service.ts`'s `systemPrompt: string`); bands flatten
 * with the exact same rule `SystemPromptSnapshot.text` uses, so a caller
 * that DOES pass the full snapshot (`src/commands/chat.ts`/`dashboard.ts`,
 * since the same issue) estimates identically to one that pre-flattened it. */
export function systemPromptText(system: string | SystemBands): string {
  return typeof system === "string" ? system : joinBands(system);
}

export interface SystemPromptInputs {
  readonly identity?: string;
  /** Issue #579 (épico #575, P3): a doutrina de comportamento
   * (`src/context/doctrine.ts`'s `doctrineText`) — a faixa `stable`, depois
   * da identidade e antes de `Environment`, omitida quando ausente (nenhuma
   * superfície é obrigada a passar doutrina). */
  readonly doctrine?: string;
  /** Issue #580 (épico #575, P4): o bloco `Harness:` por superfície e modo
   * de execução (`src/context/harness.ts`'s `harnessText`) — a faixa
   * `stable`, depois da doutrina e antes de `Environment`, omitido quando
   * ausente. */
  readonly harness?: string;
  readonly environmentHints?: Readonly<Record<string, string>>;
  readonly systemMessage?: string;
  readonly contextFiles?: readonly (readonly [string, string])[];
  readonly memorySnapshot?: string;
  readonly userProfile?: string;
  readonly skillsIndex?: string;
  readonly today?: string;
}

/** Issue #588: um valor multilinha (`git_status`, `git_recent`) quebraria a
 * forma `- key: value` — em vez disso, a chave fica sozinha e cada linha do
 * valor entra indentada duas colunas abaixo. */
function renderHintLine(key: string, value: string): string {
  if (!value.includes("\n")) return `- ${key}: ${value}`;
  const indented = value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
  return `- ${key}:\n${indented}`;
}

function environmentText(hints: Readonly<Record<string, string>>): string {
  const keys = Object.keys(hints).sort();
  if (keys.length === 0) return "";
  const lines = keys.map((key) => renderHintLine(key, hints[key] ?? ""));
  return `Environment:\n${lines.join("\n")}\n${ENVIRONMENT_SNAPSHOT_NOTE}`;
}

function contextText(files: readonly (readonly [string, string])[]): string {
  const rendered = files
    .filter(([, content]) => content.length > 0)
    .map(([name, content]) => `<context-file name="${name}">\n${content}\n</context-file>`)
    .join(SEPARATOR);
  return rendered ? `${PROJECT_INSTRUCTIONS_PREFIX}${SEPARATOR}${rendered}` : "";
}

/** Mirrors the oracle's `datetime.date.today().isoformat()` — the SYSTEM's
 * local calendar date, not UTC. `toISOString()` reads UTC components, so it
 * disagrees with the oracle for roughly a third of every day (midnight
 * local through midnight UTC, wider the further west of UTC the host is). */
function todayLocalIsoDate(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function buildSystemPrompt(inputs: SystemPromptInputs = {}): SystemPromptSnapshot {
  const today = inputs.today ?? todayLocalIsoDate();
  const stable = [
    inputs.identity || DEFAULT_IDENTITY,
    inputs.doctrine ?? "",
    inputs.harness ?? "",
    environmentText(inputs.environmentHints ?? {}),
  ]
    .filter(Boolean)
    .join(SEPARATOR);
  const context = [(inputs.systemMessage ?? "").trim(), contextText(inputs.contextFiles ?? [])]
    .filter(Boolean)
    .join(SEPARATOR);
  const volatile = [
    inputs.memorySnapshot
      ? `${MEMORY_PREFIX}${SEPARATOR}<memory>\n${inputs.memorySnapshot}\n</memory>`
      : "",
    inputs.userProfile
      ? `${USER_PROFILE_PREFIX}${SEPARATOR}<user-profile>\n${inputs.userProfile}\n</user-profile>`
      : "",
    inputs.skillsIndex ?? "",
    `Today's date is ${today}.`,
  ]
    .filter(Boolean)
    .join(SEPARATOR);
  return new SystemPromptSnapshot(stable, context, volatile);
}
