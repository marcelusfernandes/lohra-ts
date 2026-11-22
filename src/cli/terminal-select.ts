import { TerminalInputError, type TerminalInput, type TerminalKey } from "./terminal-io.js";

export interface SelectChoice<T> {
  readonly id: string;
  readonly label: string;
  readonly value: T;
}

export interface SelectionState {
  readonly cursor: number;
  readonly selected: readonly boolean[];
}

const MAX_SELECTION_ITEMS = 16;
const MAX_SELECTION_KEYS = 512;

export function reduceSelection(
  state: SelectionState,
  key: TerminalKey,
  mode: "single" | "multiple",
): { readonly state: SelectionState; readonly done: boolean } {
  const count = state.selected.length;
  if (count === 0) throw new TerminalInputError("terminal selection requires a choice");
  const move = (delta: number): SelectionState => ({
    cursor: (state.cursor + delta + count) % count,
    selected: state.selected,
  });
  switch (key.kind) {
    case "up":
    case "left":
      return { state: move(-1), done: false };
    case "down":
    case "right":
      return { state: move(1), done: false };
    case "space": {
      const selected =
        mode === "single"
          ? state.selected.map((_, index) => index === state.cursor)
          : state.selected.map((value, index) => (index === state.cursor ? !value : value));
      return { state: { cursor: state.cursor, selected }, done: false };
    }
    case "enter": {
      if (mode === "single" && !state.selected.some((value) => value)) {
        return {
          state: {
            cursor: state.cursor,
            selected: state.selected.map((_, index) => index === state.cursor),
          },
          done: true,
        };
      }
      return { state, done: true };
    }
    case "backspace":
    case "char":
      return { state, done: false };
    default: {
      const neverKey: never = key;
      return neverKey;
    }
  }
}

export function renderSelection(options: {
  readonly title: string;
  readonly hint: string;
  readonly labels: readonly string[];
  readonly state: SelectionState;
}): string {
  const rows = options.labels.map((label, index) => {
    const cursor = index === options.state.cursor ? ">" : " ";
    const mark = options.state.selected[index] === true ? "x" : " ";
    return `${cursor} [${mark}] ${label}`;
  });
  return `${options.title}\n${options.hint}\n${rows.join("\n")}\n`;
}

function paint(frame: string, previousLines: number, write: (text: string) => void): number {
  const body = frame.endsWith("\n") ? frame.slice(0, -1).split("\n") : frame.split("\n");
  const up = previousLines > 0 ? `\x1b[${String(previousLines)}A` : "";
  try {
    write(`${up}${body.map((line) => `\x1b[2K${line}`).join("\n")}\n`);
  } catch (cause) {
    throw new TerminalInputError("terminal prompt output failed", { cause });
  }
  return body.length;
}

function assertDisplayable(label: string): void {
  if (label.length === 0 || label.length > 512) {
    throw new TerminalInputError("terminal selection item is not displayable");
  }
  for (const char of label) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) {
      throw new TerminalInputError("terminal selection item is not displayable");
    }
  }
}

/** Bounded keyboard selector. One reader: the caller's {@link TerminalInput}. */
export async function promptSelect<T>(options: {
  readonly input: TerminalInput;
  readonly write: (text: string) => void;
  readonly title: string;
  readonly hint: string;
  readonly mode: "single" | "multiple";
  readonly items: readonly SelectChoice<T>[];
}): Promise<readonly T[]> {
  if (options.items.length > MAX_SELECTION_ITEMS) {
    throw new TerminalInputError("terminal selection item limit exceeded");
  }
  for (const item of options.items) assertDisplayable(item.label);
  if (options.items.length === 0) {
    if (options.mode === "single")
      throw new TerminalInputError("terminal selection requires a choice");
    return [];
  }
  let current: SelectionState = {
    cursor: 0,
    selected: options.items.map(() => false),
  };
  const frame = (): string =>
    renderSelection({
      title: options.title,
      hint: options.hint,
      labels: options.items.map((item) => item.label),
      state: current,
    });
  let drawn = paint(frame(), 0, options.write);
  for (let accepted = 0; accepted < MAX_SELECTION_KEYS; accepted += 1) {
    const key = await options.input.readKey();
    const next = reduceSelection(current, key, options.mode);
    current = next.state;
    drawn = paint(frame(), drawn, options.write);
    if (next.done) {
      const values: T[] = [];
      current.selected.forEach((isSelected, index) => {
        const item = options.items[index];
        if (isSelected && item) values.push(item.value);
      });
      return values;
    }
  }
  throw new TerminalInputError("terminal selection input limit exceeded");
}
