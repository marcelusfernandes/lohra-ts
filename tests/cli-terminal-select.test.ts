import { PassThrough } from "node:stream";
import type { ReadStream } from "node:tty";

import { describe, expect, it } from "vitest";

import { terminalInput } from "../src/cli/terminal-io.js";
import {
  promptSelect,
  reduceSelection,
  renderSelection,
  type SelectionState,
} from "../src/cli/terminal-select.js";

const title = "clients — arrows move, Space toggles, Enter confirms";
const hint = "Unchecking a client does not uninstall it. Use `lohra skills remove` to remove one.";

function state(cursor: number, selected: readonly boolean[]): SelectionState {
  return { cursor, selected };
}

function tty() {
  const writes: string[] = [];
  const stream = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(this: { isRaw: boolean }, value: boolean) {
      this.isRaw = value;
    },
  });
  const write = (value: string): void => {
    writes.push(value);
  };
  const input = terminalInput(stream as unknown as ReadStream, true, write);
  return { stream, input, write, writes };
}

const items = [
  { id: "a", label: "Alpha", value: "Alpha" },
  { id: "b", label: "Beta", value: "Beta" },
  { id: "c", label: "Gamma", value: "Gamma" },
  { id: "d", label: "Delta", value: "Delta" },
];

describe("terminal selection", () => {
  it("moves, toggles, wraps, and confirms without mutating the previous state", () => {
    const initial = state(0, [false, false, false, false]);
    const down = reduceSelection(initial, { kind: "down" }, "multiple");
    expect(down.state.cursor).toBe(1);
    expect(initial.selected).toEqual([false, false, false, false]);
    const toggled = reduceSelection(down.state, { kind: "space" }, "multiple");
    expect(toggled.state.selected).toEqual([false, true, false, false]);
    expect(down.state.selected).toEqual([false, false, false, false]);
    expect(toggled.state.selected).not.toBe(down.state.selected);
    const wrapped = reduceSelection(initial, { kind: "up" }, "multiple");
    expect(wrapped.state.cursor).toBe(3);
    expect(reduceSelection(wrapped.state, { kind: "right" }, "multiple").state.cursor).toBe(0);
    const single = reduceSelection(state(1, [true, false]), { kind: "space" }, "single");
    expect(single.state.selected).toEqual([false, true]);
    const confirmed = reduceSelection(
      state(2, [false, false, false, false]),
      { kind: "enter" },
      "single",
    );
    expect(confirmed.done).toBe(true);
    expect(confirmed.state.selected).toEqual([false, false, true, false]);
    expect(reduceSelection(toggled.state, { kind: "char", value: "z" }, "multiple").done).toBe(
      false,
    );
    expect(reduceSelection(toggled.state, { kind: "enter" }, "multiple")).toMatchObject({
      done: true,
      state: toggled.state,
    });
  });

  it("renders the cursor, the marks, and the removal hint", () => {
    expect(
      renderSelection({
        title,
        hint,
        labels: ["Alpha", "Beta"],
        state: state(1, [true, false]),
      }),
    ).toBe(`${title}\n${hint}\n  [x] Alpha\n> [ ] Beta\n`);
  });

  it("drives multi-select from terminal bytes, including none and all", async () => {
    const all = tty();
    const pendingAll = promptSelect({
      input: all.input,
      write: all.write,
      title,
      hint,
      mode: "multiple",
      items,
    });
    all.stream.write(" \x1b[B \x1b[B \x1b[B \r");
    expect(await pendingAll).toEqual(["Alpha", "Beta", "Gamma", "Delta"]);
    expect(all.writes.join("")).toContain("> [x] Delta");
    expect(all.writes.join("")).toContain("lohra skills remove");
    expect(all.writes.join("")).not.toContain("\x1b[B");
    all.input.close();
    expect(all.stream.isRaw).toBe(false);
    expect(all.stream.listenerCount("data")).toBe(0);

    const none = tty();
    const pendingNone = promptSelect({
      input: none.input,
      write: none.write,
      title,
      hint,
      mode: "multiple",
      items,
    });
    none.stream.write("z\r");
    expect(await pendingNone).toEqual([]);
    expect(none.writes.join("")).not.toContain("z");
    none.input.close();
  });

  it("confirms one highlighted or explicitly marked choice", async () => {
    const highlighted = tty();
    const byEnter = promptSelect({
      input: highlighted.input,
      write: highlighted.write,
      title,
      hint,
      mode: "single",
      items,
    });
    highlighted.stream.write("\x1b[B\r");
    expect(await byEnter).toEqual(["Beta"]);
    highlighted.input.close();

    const marked = tty();
    const bySpace = promptSelect({
      input: marked.input,
      write: marked.write,
      title,
      hint,
      mode: "single",
      items,
    });
    marked.stream.write(" \x1b[B\r");
    expect(await bySpace).toEqual(["Alpha"]);
    marked.input.close();
  });

  it("cancels from the terminal and restores raw mode and listeners", async () => {
    const { stream, input, write } = tty();
    const before = process.listenerCount("SIGINT");
    const pending = promptSelect({
      input,
      write,
      title,
      hint,
      mode: "multiple",
      items,
    });
    stream.write("\u0003");
    await expect(pending).rejects.toThrow("cancelled");
    input.close();
    expect(stream.isRaw).toBe(false);
    expect(stream.listenerCount("data")).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("rejects an unbounded item list and stops after the key budget", async () => {
    const closed = tty();
    const tooMany = Array.from({ length: 17 }, (_, index) => ({
      id: String(index),
      label: `Item ${String(index)}`,
      value: index,
    }));
    await expect(
      promptSelect({
        input: closed.input,
        write: closed.write,
        title,
        hint,
        mode: "multiple",
        items: tooMany,
      }),
    ).rejects.toThrow("item limit");
    expect(closed.stream.isRaw).toBe(false);
    await expect(
      promptSelect({
        input: closed.input,
        write: closed.write,
        title,
        hint,
        mode: "multiple",
        items: [{ id: "bad", label: "bad\nlabel", value: "bad" }],
      }),
    ).rejects.toThrow("not displayable");
    expect(
      await promptSelect({
        input: closed.input,
        write: closed.write,
        title,
        hint,
        mode: "multiple",
        items: [],
      }),
    ).toEqual([]);
    await expect(
      promptSelect({
        input: closed.input,
        write: closed.write,
        title,
        hint,
        mode: "single",
        items: [],
      }),
    ).rejects.toThrow("requires a choice");
    closed.input.close();

    const bounded = tty();
    const pending = promptSelect({
      input: bounded.input,
      write: bounded.write,
      title,
      hint,
      mode: "multiple",
      items,
    });
    const rejection = expect(pending).rejects.toThrow("input limit exceeded");
    for (let sent = 0; sent < 512; sent += 1) {
      bounded.stream.write("\x1b[B");
      await Promise.resolve();
    }
    await rejection;
    bounded.input.close();
    expect(bounded.stream.isRaw).toBe(false);
    expect(bounded.stream.listenerCount("data")).toBe(0);
  });
});
