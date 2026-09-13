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

export function parseOutcomeSentinel(_content: string): SubagentOutcome | null {
  throw new Error("not implemented: parseOutcomeSentinel");
}
