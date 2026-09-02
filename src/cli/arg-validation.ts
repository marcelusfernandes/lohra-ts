import type { CommandSpec, FlagSpec } from "./arg-spec.js";

/** A faithful, general-purpose transcription of argparse's own parsing
 * rules (not a per-cell patch list): a `-`-prefixed token is never consumed
 * as an option's value; an error belongs to whichever parser level
 * encountered it, reported with that level's own usage banner; `--` ends
 * option processing. One parse produces one truth — both `cli.ts`'s
 * rejection reporting and (for `chat`) the command's own flag/positional
 * extraction read from the same `ParseResult`, so they cannot independently
 * drift the way validation and extraction once did. */

export type CommandError =
  | { readonly kind: "ambiguous"; readonly token: string; readonly candidates: readonly string[] }
  | { readonly kind: "missingValue"; readonly flag: string }
  | { readonly kind: "invalidInt"; readonly flag: string; readonly value: string }
  | { readonly kind: "invalidFloat"; readonly flag: string; readonly value: string }
  | { readonly kind: "unexpectedValue"; readonly flag: string; readonly value: string }
  | { readonly kind: "requiredMissing"; readonly name: string }
  | {
      readonly kind: "invalidChoice";
      readonly name: string;
      readonly value: string;
      readonly choices: readonly string[];
    };

export interface ParseResult {
  readonly options: ReadonlyMap<string, string | true>;
  readonly positionals: readonly string[];
  readonly extras: readonly string[];
  readonly error: CommandError | null;
}

/** Python's `int()` accepts an optional sign and ASCII digits (with
 * surrounding whitespace); it rejects decimals, empty strings, and
 * non-digit text — that's the surface argparse's `type=int` relies on. */
function isPythonInt(value: string): boolean {
  return /^[+-]?\d+$/.test(value.trim());
}

function isFinitePythonFloat(value: string): boolean {
  const stripped = value.trim();
  return stripped !== "" && Number.isFinite(Number(stripped));
}

/** argparse: a token starting with `-` is option-like unless it's exactly
 * "-" or looks like a negative number (no spec here declares a negative-
 * number-shaped flag, so that carve-out is unconditionally safe). Such a
 * token is never eligible to fill a positional slot or be consumed as an
 * option's value. */
function looksLikeOption(token: string): boolean {
  if (!token.startsWith("-") || token === "-") return false;
  return !/^-\d+$/.test(token) && !/^-\d*\.\d+$/.test(token);
}

export function parseCommand(spec: CommandSpec, argv: readonly string[]): ParseResult {
  const options = new Map<string, string | true>();
  const positionals: string[] = [];
  const extras: string[] = [];
  let seenDoubleDash = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!seenDoubleDash && token === "--") {
      seenDoubleDash = true;
      continue;
    }
    if (!seenDoubleDash && looksLikeOption(token)) {
      const eq = token.indexOf("=");
      const name = eq < 0 ? token : token.slice(0, eq);
      const inline = eq < 0 ? undefined : token.slice(eq + 1);
      const exact = spec.flags.find((flag) => flag.name === name);
      const candidates =
        exact !== undefined ? [exact] : spec.flags.filter((flag) => flag.name.startsWith(name));
      if (candidates.length === 0) {
        extras.push(token);
        continue;
      }
      if (candidates.length > 1) {
        return {
          options,
          positionals,
          extras,
          error: {
            kind: "ambiguous",
            token: name,
            candidates: candidates.map((flag) => flag.name),
          },
        };
      }
      const flag = candidates[0] as FlagSpec;
      if (!flag.takesValue) {
        if (inline !== undefined)
          return {
            options,
            positionals,
            extras,
            error: { kind: "unexpectedValue", flag: flag.name, value: inline },
          };
        options.set(flag.name, true);
        continue;
      }
      const next = inline ?? argv[index + 1];
      const consumesNext = inline === undefined;
      // seenDoubleDash is always false here (this whole branch is guarded
      // by !seenDoubleDash above), so the "next" token itself is still
      // subject to option-like detection when it would be consumed as
      // this flag's value.
      if (next === undefined || (consumesNext && looksLikeOption(next)))
        return { options, positionals, extras, error: { kind: "missingValue", flag: flag.name } };
      if (consumesNext) index += 1;
      if (flag.type === "int" && !isPythonInt(next))
        return {
          options,
          positionals,
          extras,
          error: { kind: "invalidInt", flag: flag.name, value: next },
        };
      if (flag.type === "float" && !isFinitePythonFloat(next))
        return {
          options,
          positionals,
          extras,
          error: { kind: "invalidFloat", flag: flag.name, value: next },
        };
      options.set(flag.name, next);
      continue;
    }
    const slot = spec.positionals[positionals.length];
    if (slot === undefined) {
      extras.push(token);
      continue;
    }
    if (slot.choices !== undefined && !slot.choices.includes(token))
      return {
        options,
        positionals,
        extras,
        error: { kind: "invalidChoice", name: slot.name, value: token, choices: slot.choices },
      };
    positionals.push(token);
  }

  for (let index = positionals.length; index < spec.positionals.length; index += 1) {
    const slot = spec.positionals[index] as { readonly name: string; readonly required: boolean };
    if (slot.required)
      return { options, positionals, extras, error: { kind: "requiredMissing", name: slot.name } };
  }

  return { options, positionals, extras, error: null };
}

export interface Level {
  readonly prefix: string;
  readonly banner: string;
}

// Byte-exact against live oracle runs (`--help`-shaped usage lines, and
// forced parse errors for each subcommand). Argparse's usage-wrapping
// algorithm is not reproduced generatively here — every banner below is a
// direct capture, not a computed layout.
export const TOP_LEVEL: Level = {
  prefix: "lohra",
  banner:
    "usage: lohra [-h] [--version]\n" +
    "             {init,doctor,chat,dashboard,serve,cron,workflow,models,tiers,profile,auth,skill,update}\n" +
    "             ...\n",
};

export const LEVELS = {
  init: {
    prefix: "lohra init",
    banner: "usage: lohra init [-h] [--profile PROFILE] [--no-input]\n",
  },
  doctor: {
    prefix: "lohra doctor",
    banner: "usage: lohra doctor [-h] [--profile PROFILE] [--no-input] [--json]\n",
  },
  chat: {
    prefix: "lohra chat",
    banner:
      "usage: lohra chat [-h] [--profile PROFILE] [--no-input] [--model MODEL]\n" +
      "                  [--provider PROVIDER] [--session SESSION] [--no-tools]\n" +
      "                  [--yolo] [--json] [--max-parallel MAX_PARALLEL]\n" +
      "                  [--max-iterations MAX_ITERATIONS]\n" +
      "                  prompt\n",
  },
  serve: {
    prefix: "lohra serve",
    banner:
      "usage: lohra serve [-h] [--profile PROFILE] [--no-input] [--host HOST]\n" +
      "                   [--port PORT] [--insecure] [--tools TOOLS]\n",
  },
  models: {
    prefix: "lohra models",
    banner:
      "usage: lohra models [-h] [--profile PROFILE] [--no-input]\n" +
      "                    [--provider PROVIDER] [--json]\n",
  },
  tiers: { prefix: "lohra tiers", banner: "usage: lohra tiers [-h] {list,suggest} ...\n" },
  tiersList: {
    prefix: "lohra tiers list",
    banner: "usage: lohra tiers list [-h] [--profile PROFILE] [--no-input]\n",
  },
  tiersSuggest: {
    prefix: "lohra tiers suggest",
    banner: "usage: lohra tiers suggest [-h] [--profile PROFILE] [--no-input] [--yes]\n",
  },
  profile: { prefix: "lohra profile", banner: "usage: lohra profile [-h] {list,create} [name]\n" },
  auth: {
    prefix: "lohra auth",
    banner:
      "usage: lohra auth [-h] [--profile PROFILE] [--no-input] [--yes]\n" +
      "                  {status,enable,disable,login,logout,prefer} [value]\n",
  },
  skill: { prefix: "lohra skill", banner: "usage: lohra skill [-h] {export} ...\n" },
  skillExport: {
    prefix: "lohra skill export",
    banner: "usage: lohra skill export [-h] [--to TO] name\n",
  },
  workflow: {
    prefix: "lohra workflow",
    banner: "usage: lohra workflow [-h] [--profile PROFILE] [--no-input] {list,watch,audit} ...\n",
  },
  workflowList: {
    prefix: "lohra workflow list",
    banner: "usage: lohra workflow list [-h] [--limit LIMIT]\n",
  },
  workflowWatch: {
    prefix: "lohra workflow watch",
    banner: "usage: lohra workflow watch [-h] [--last] [--poll POLL] [run_id]\n",
  },
  workflowAudit: {
    prefix: "lohra workflow audit",
    banner:
      "usage: lohra workflow audit [-h] [--node NODE_ID] [--event EVENT_TYPE]\n" +
      "                            [--sub-id SUB_ID] [--segment-id SEGMENT_ID]\n" +
      "                            [--attempt ATTEMPT] [--after-seq AFTER_SEQ]\n" +
      "                            [--snapshot-seq SNAPSHOT_SEQ] [--limit LIMIT]\n" +
      "                            run_id\n",
  },
} as const satisfies Record<string, Level>;

export function renderError(error: CommandError, level: Level): string {
  const prefix = `${level.banner}${level.prefix}: error: `;
  switch (error.kind) {
    case "ambiguous":
      return `${prefix}ambiguous option: ${error.token} could match ${error.candidates.join(", ")}\n`;
    case "missingValue":
      return `${prefix}argument ${error.flag}: expected one argument\n`;
    case "invalidInt":
      return `${prefix}argument ${error.flag}: invalid int value: '${error.value}'\n`;
    case "invalidFloat":
      return `${prefix}argument ${error.flag}: invalid float value: '${error.value}'\n`;
    case "unexpectedValue":
      return `${prefix}argument ${error.flag}: ignored explicit argument '${error.value}'\n`;
    case "requiredMissing":
      return `${prefix}the following arguments are required: ${error.name}\n`;
    case "invalidChoice":
      return `${prefix}argument ${error.name}: invalid choice: '${error.value}' (choose from ${error.choices.join(", ")})\n`;
  }
}

export function unrecognizedArguments(tokens: readonly string[]): string {
  return `${TOP_LEVEL.banner}${TOP_LEVEL.prefix}: error: unrecognized arguments: ${tokens.join(" ")}\n`;
}

export function invalidTopLevelChoice(value: string, choices: readonly string[]): string {
  return `${TOP_LEVEL.banner}${TOP_LEVEL.prefix}: error: argument command: invalid choice: '${value}' (choose from ${choices.join(", ")})\n`;
}

/** When `argv[0]` doesn't resolve to a known command, the oracle's own
 * top-level parser scans forward for the first non-option-like token to
 * test as the `command` positional's value (a bad value there is an
 * immediate "invalid choice" error); if no such token exists anywhere in
 * argv, every token is an unmatched extra instead — measured against
 * `lohra --frobnicate` (solo, unrecognized), `lohra --profile foo`
 * (invalid choice: 'foo', not 'invalid --profile'), and
 * `lohra --frobnicate extra1 extra2` (invalid choice: 'extra1'). A flag
 * appearing before a VALID subcommand name is not handled — cli.ts's
 * dispatch only ever inspects `argv[0]` directly, and no measured case
 * exercises that combination. */
export function classifyUnknownCommand(
  argv: readonly string[],
):
  | { readonly kind: "invalidChoice"; readonly value: string }
  | { readonly kind: "unrecognized"; readonly tokens: readonly string[] } {
  for (const token of argv) {
    if (!looksLikeOption(token)) return { kind: "invalidChoice", value: token };
  }
  return { kind: "unrecognized", tokens: argv };
}
