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

export class SystemPromptSnapshot {
  readonly stable: string;
  readonly context: string;
  readonly volatile: string;
  readonly text: string;

  constructor(stable: string, context: string, volatile: string) {
    this.stable = stable;
    this.context = context;
    this.volatile = volatile;
    this.text = [stable, context, volatile].filter(Boolean).join(SEPARATOR);
    Object.freeze(this);
  }
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

function environmentText(hints: Readonly<Record<string, string>>): string {
  const keys = Object.keys(hints).sort();
  return keys.length === 0
    ? ""
    : `Environment:\n${keys.map((key) => `- ${key}: ${hints[key] ?? ""}`).join("\n")}`;
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
