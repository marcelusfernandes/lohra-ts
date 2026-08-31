import type { CommandSpec, FlagSpec } from "./arg-spec.js";

export interface ArgTypeError {
  readonly flag: string;
  readonly value: string;
}

export interface ArgValidation {
  readonly unrecognized: readonly string[];
  readonly typeError: ArgTypeError | null;
}

const NO_TYPE_ERROR: ArgValidation["typeError"] = null;

/** Python's `int()` accepts an optional sign and ASCII digits (with
 * surrounding whitespace); it rejects decimals, empty strings, and
 * non-digit text — that's the surface argparse's `type=int` relies on. */
function isPythonInt(value: string): boolean {
  return /^[+-]?\d+$/.test(value.trim());
}

/** argparse's default `allow_abbrev=True`: an option may be given as any
 * unambiguous prefix of its full name. Exact match wins outright; a prefix
 * is honored only when it matches exactly one flag in the spec. */
function matchFlag(flags: readonly FlagSpec[], name: string): FlagSpec | undefined {
  const exact = flags.find((flag) => flag.name === name);
  if (exact !== undefined) return exact;
  const prefixMatches = flags.filter((flag) => flag.name.startsWith(name));
  return prefixMatches.length === 1 ? prefixMatches[0] : undefined;
}

/** Mirrors argparse's `parse_known_args` for a single (sub)command level:
 * walks argv left to right, matches `--flag`/`--flag=value` against the
 * spec (unknown flags never consume a following token as their value, the
 * same as argparse — it has no arity for something it doesn't recognize),
 * fills positional slots in order, and collects everything else into
 * `unrecognized`, in argv order — exactly how `unrecognized arguments: ...`
 * reports them. An int-typed flag given a non-integer value short-circuits
 * into `typeError`, matching argparse's own precedence: a type-conversion
 * error is raised while still parsing, before "extras" are ever computed. */
export function validateArgs(spec: CommandSpec, argv: readonly string[]): ArgValidation {
  const unrecognized: string[] = [];
  let positionalsSeen = 0;
  let typeError = NO_TYPE_ERROR;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq < 0 ? token : token.slice(0, eq);
      const inline = eq < 0 ? undefined : token.slice(eq + 1);
      const flag = matchFlag(spec.flags, name);
      if (flag === undefined) {
        unrecognized.push(token);
        continue;
      }
      if (!flag.takesValue) continue;
      const value = inline ?? argv[index + 1];
      if (inline === undefined) index += 1;
      if (typeError === null && flag.type === "int" && value !== undefined && !isPythonInt(value)) {
        typeError = { flag: flag.name, value };
      }
      continue;
    }
    if (positionalsSeen < spec.positionalCount) {
      positionalsSeen += 1;
      continue;
    }
    unrecognized.push(token);
  }
  return { unrecognized, typeError };
}

// Byte-exact against a live oracle run (`chat --max-iterations abc`);
// chat is the only implemented command with a measured invalid-int case,
// so this banner is not generalized to other subcommands.
export const CHAT_USAGE_BANNER =
  "usage: lohra chat [-h] [--profile PROFILE] [--no-input] [--model MODEL]\n" +
  "                  [--provider PROVIDER] [--session SESSION] [--no-tools]\n" +
  "                  [--yolo] [--json] [--max-parallel MAX_PARALLEL]\n" +
  "                  [--max-iterations MAX_ITERATIONS]\n" +
  "                  prompt\n";

export function chatTypeErrorMessage(flag: string, value: string): string {
  return `${CHAT_USAGE_BANNER}lohra chat: error: argument ${flag}: invalid int value: '${value}'\n`;
}
