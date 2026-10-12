// Bounded, turn-local context for a cancelled turn. Only the original user
// request and tool NAMES are retained here; dispatch arguments and results
// never enter the notice. A returned dispatch may itself contain an error.
const REQUEST_LIMIT = 700;
const TOOL_NAME_LIMIT = 48;
const TOOL_LIST_LIMIT = 8;

function excerpt(value: string, limit: number): string {
  const clean = value
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const characters = Array.from(clean);
  const clipped = characters.slice(0, limit).join("");
  return characters.length > limit ? `${clipped}…` : clipped;
}

interface DispatchSnapshot {
  readonly returned: readonly string[];
  readonly returnedCount: number;
  readonly inFlight: readonly string[];
}

export function createCancellationNoticeTracker(
  input: string,
  signal: AbortSignal,
): {
  dispatch<T>(name: string, run: () => Promise<T>): Promise<T>;
  context(): string;
  dispose(): void;
} {
  const request = excerpt(input, REQUEST_LIMIT);
  const active = new Map<number, string>();
  const returned: string[] = [];
  let returnedCount = 0;
  let nextId = 0;
  let atAbort: DispatchSnapshot | null = null;
  const capture = (): DispatchSnapshot => ({
    returned: [...returned],
    returnedCount,
    inFlight: [...active.values()].slice(0, TOOL_LIST_LIMIT),
  });
  const onAbort = (): void => {
    atAbort ??= capture();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();

  return {
    async dispatch<T>(name: string, run: () => Promise<T>): Promise<T> {
      const id = nextId++;
      const boundedName = excerpt(name, TOOL_NAME_LIMIT);
      active.set(id, boundedName);
      try {
        return await run();
      } finally {
        active.delete(id);
        returnedCount += 1;
        if (returned.length < TOOL_LIST_LIMIT) returned.push(boundedName);
      }
    },
    context(): string {
      const snapshot = atAbort ?? capture();
      const details = [`Interrupted request: ${JSON.stringify(request || "(empty request)")}.`];
      if (snapshot.returnedCount > 0) {
        const extra = snapshot.returnedCount - snapshot.returned.length;
        details.push(
          `Tool dispatch returned (success not guaranteed): ${snapshot.returned.map((name) => JSON.stringify(name)).join(", ")}${extra > 0 ? `, ${String(extra)} more omitted` : ""}.`,
        );
      }
      if (snapshot.inFlight.length > 0) {
        details.push(
          `Tool dispatch in flight at cancellation (outcome unknown; verify): ${snapshot.inFlight.map((name) => JSON.stringify(name)).join(", ")}.`,
        );
      }
      details.push(
        "This turn was interrupted. Files already written may exist; verify state before continuing. Do not automatically replay actions.",
      );
      return details.join(" ");
    },
    dispose(): void {
      signal.removeEventListener("abort", onAbort);
    },
  };
}
