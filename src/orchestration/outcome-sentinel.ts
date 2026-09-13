// Issue #583 (épico #575, P7): o contrato de retorno do subagente. O
// prompt do filho (`subagent-prompt.ts`) pede uma última linha no formato
// `result: <summary>` | `failed: <why>` | `needs input: <what>` — este
// módulo é o único leitor dessa linha, chamado por `child-runner.ts` sobre
// o `content` final de um turno "complete". Nunca lança: uma última linha
// que não casa nenhum padrão (ou um texto vazio) é `null`, nunca erro — o
// modelo pode legitimamente terminar sem a sentinela, e isso não é uma
// falha do turno (`status`/`error_kind` continuam intocados por este
// módulo, decisão 3 da issue).
export type SubagentOutcome = "result" | "failed" | "needs_input";

const SENTINELS: ReadonlyArray<{ readonly pattern: RegExp; readonly outcome: SubagentOutcome }> = [
  { pattern: /^result:\s?/iu, outcome: "result" },
  { pattern: /^failed:\s?/iu, outcome: "failed" },
  { pattern: /^needs input:\s?/iu, outcome: "needs_input" },
];

/** Last non-blank line of `content`, trimmed — `null` when every line is
 * blank (including empty content). */
function lastNonBlankLine(content: string): string | null {
  const lines = content.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").trim();
    if (line.length > 0) return line;
  }
  return null;
}

export function parseOutcomeSentinel(content: string): SubagentOutcome | null {
  const line = lastNonBlankLine(content);
  if (line === null) return null;
  const matched = SENTINELS.find(({ pattern }) => pattern.test(line));
  return matched?.outcome ?? null;
}
