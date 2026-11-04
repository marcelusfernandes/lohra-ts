import { inspect } from "node:util";

/** The name an error goes by in a report: its `name`, or `Error` when it has
 * none worth showing. */
function nameOf(error: unknown): string {
  if (error instanceof Error && error.name.trim() !== "") return error.name;
  return "Error";
}

/** What one level says of its own, or `""` when it says nothing.
 *
 * An error that is not a plain `Error` is introduced by its name
 * (`TypeError: …`), so a bug in the runtime is recognisable. A level with an
 * empty message is its name. An `AggregateError` is the exception on both
 * counts: it only groups its members, so its name tells nothing, and with no
 * message it adds no line (the members carry the content). */
function levelText(error: object): string {
  if (!(error instanceof Error)) return inspect(error, { breakLength: Infinity });
  const message = error.message.trim() === "" ? "" : error.message;
  if (error instanceof AggregateError) return message;
  const name = nameOf(error);
  if (message === "") return name;
  return name === "Error" ? message : `${name}: ${message}`;
}

function primitiveText(value: unknown): string {
  const text = String(value);
  return text.trim() === "" ? inspect(value) : text;
}

/** The text of `error` and of everything it was caused by (`cause`, and the
 * members of an `AggregateError`), outermost first. Each object appears once,
 * so a cycle or a cause shared by two levels does not repeat or loop. */
function collectTexts(error: unknown, seen: Set<object>): string[] {
  if (typeof error !== "object" || error === null) return [primitiveText(error)];
  if (seen.has(error)) return [];
  seen.add(error);
  const causes: unknown[] = [];
  if ("cause" in error && error.cause !== undefined) causes.push(error.cause);
  if (error instanceof AggregateError) {
    const members: readonly unknown[] = error.errors;
    causes.push(...members);
  }
  const own = levelText(error);
  return [...(own === "" ? [] : [own]), ...causes.flatMap((cause) => collectTexts(cause, seen))];
}

/** The lines that report `error` to a person: the outermost message first
 * (introduced by its type unless it is a plain `Error`), then one
 * `caused by: …` line per cause. Never empty and never a blank line, and
 * nothing the chain says is dropped. The caller adds its own prefix to the
 * first line (`error: `) and decides where the lines go. */
export function failureReportLines(error: unknown): readonly string[] {
  const [first, ...causes] = collectTexts(error, new Set());
  if (first === undefined) return [nameOf(error)];
  return [first, ...causes.map((cause) => `caused by: ${cause}`)];
}
