// Issue #580 (épico #575, P4): stub vermelho — o bloco `Harness:` real entra
// no commit seguinte. Ver `tests/context-harness-mode.test.ts` para o
// contrato que `harnessText` precisa cumprir.
export type PromptMode = "headless" | "interactive" | "server" | "subagent";

export interface HarnessTextInput {
  readonly mode: PromptMode;
  readonly yolo?: boolean;
}

export function harnessText(_input: HarnessTextInput): string {
  throw new Error("not implemented: harnessText");
}
