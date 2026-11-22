import type { TerminalInput, TerminalKey } from "./terminal-io.js";

export interface SelectChoice<T> {
  readonly id: string;
  readonly label: string;
  readonly value: T;
}

export interface SelectionState {
  readonly cursor: number;
  readonly selected: readonly boolean[];
}

export function reduceSelection(
  _state: SelectionState,
  _key: TerminalKey,
  _mode: "single" | "multiple",
): { readonly state: SelectionState; readonly done: boolean } {
  throw new Error("not implemented");
}

export function renderSelection(_options: {
  readonly title: string;
  readonly hint: string;
  readonly labels: readonly string[];
  readonly state: SelectionState;
}): string {
  throw new Error("not implemented");
}

/** Bounded keyboard selector. One reader: the caller's {@link TerminalInput}. */
export async function promptSelect<T>(_options: {
  readonly input: TerminalInput;
  readonly write: (text: string) => void;
  readonly title: string;
  readonly hint: string;
  readonly mode: "single" | "multiple";
  readonly items: readonly SelectChoice<T>[];
}): Promise<readonly T[]> {
  throw new Error("not implemented");
}
