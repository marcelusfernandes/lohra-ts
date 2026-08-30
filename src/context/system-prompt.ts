export const DEFAULT_IDENTITY =
  "You are Lohra, a self-improving AI assistant. You are helpful, " +
  "knowledgeable, and direct. You use tools to take real action and you " +
  "never fabricate results — reporting a blocker honestly is always better " +
  "than inventing an outcome.";

const SEPARATOR = "\n\n";

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
  return files
    .filter(([, content]) => content.length > 0)
    .map(([name, content]) => `<context-file name="${name}">\n${content}\n</context-file>`)
    .join(SEPARATOR);
}

export function buildSystemPrompt(inputs: SystemPromptInputs = {}): SystemPromptSnapshot {
  const today = inputs.today ?? new Date().toISOString().slice(0, 10);
  const stable = [
    inputs.identity || DEFAULT_IDENTITY,
    environmentText(inputs.environmentHints ?? {}),
  ]
    .filter(Boolean)
    .join(SEPARATOR);
  const context = [(inputs.systemMessage ?? "").trim(), contextText(inputs.contextFiles ?? [])]
    .filter(Boolean)
    .join(SEPARATOR);
  const volatile = [
    inputs.memorySnapshot ? `<memory>\n${inputs.memorySnapshot}\n</memory>` : "",
    inputs.userProfile ? `<user-profile>\n${inputs.userProfile}\n</user-profile>` : "",
    inputs.skillsIndex ?? "",
    `Today's date is ${today}.`,
  ]
    .filter(Boolean)
    .join(SEPARATOR);
  return new SystemPromptSnapshot(stable, context, volatile);
}
