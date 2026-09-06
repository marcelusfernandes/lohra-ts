import { FLAG_HELP, type CommandSpec, type FlagSpec } from "./arg-spec.js";

/** The parsing rules shared by every command: a `-`-prefixed token is never
 * consumed as an option's value; an error belongs to whichever parser level
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

/** An integer flag accepts an optional sign and ASCII digits, with
 * surrounding whitespace trimmed; decimals, empty strings, and non-digit
 * text are all rejected. */
function isPythonInt(value: string): boolean {
  return /^[+-]?\d+$/.test(value.trim());
}

function isFinitePythonFloat(value: string): boolean {
  const stripped = value.trim();
  return stripped !== "" && Number.isFinite(Number(stripped));
}

function isPythonFloat(value: string): boolean {
  const stripped = value.trim();
  const lower = stripped.toLowerCase();
  return (
    isFinitePythonFloat(stripped) ||
    lower === "nan" ||
    lower === "+nan" ||
    lower === "-nan" ||
    lower === "inf" ||
    lower === "+inf" ||
    lower === "-inf" ||
    lower === "infinity" ||
    lower === "+infinity" ||
    lower === "-infinity"
  );
}

/** A token starting with `-` is option-like unless it's exactly "-" or looks
 * like a negative number (no spec here declares a negative-number-shaped
 * flag, so that carve-out is unconditionally safe). Such a token is never
 * eligible to fill a positional slot or be consumed as an option's value. */
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
      if (
        (flag.type === "float" && !isPythonFloat(next)) ||
        (flag.type === "finiteFloat" && !isFinitePythonFloat(next))
      )
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
  readonly banner: string;
}

function level(path: string): Level {
  return { banner: `usage: lohra ${path} [options]\n` };
}

export const TOP_LEVEL: Level = { banner: "usage: lohra <command> [options]\n" };

// Each level's usage banner is a single, stable, greppable line — no flag
// list, no `[-h]`, no `{choice,list}`. Per-flag and per-subcommand detail
// lives in `--help` (`renderHelp` below), not in this banner.
export const LEVELS = {
  init: level("init"),
  doctor: level("doctor"),
  chat: level("chat"),
  dashboard: level("dashboard"),
  cron: level("cron"),
  serve: level("serve"),
  models: level("models"),
  tiers: level("tiers"),
  tiersList: level("tiers list"),
  tiersSuggest: level("tiers suggest"),
  profile: level("profile"),
  auth: level("auth"),
  skill: level("skill"),
  skillExport: level("skill export"),
  workflow: level("workflow"),
  workflowList: level("workflow list"),
  workflowWatch: level("workflow watch"),
  workflowAudit: level("workflow audit"),
  update: level("update"),
} as const satisfies Record<string, Level>;

export function renderError(error: CommandError, level: Level): string {
  const prefix = `${level.banner}lohra: error: `;
  switch (error.kind) {
    case "ambiguous":
      return `${prefix}option ${error.token} is ambiguous; could match ${error.candidates.join(", ")}\n`;
    case "missingValue":
      return `${prefix}option ${error.flag} needs a value\n`;
    case "invalidInt":
      return `${prefix}option ${error.flag} expects an integer, got ${JSON.stringify(error.value)}\n`;
    case "invalidFloat":
      return `${prefix}option ${error.flag} expects a number, got ${JSON.stringify(error.value)}\n`;
    case "unexpectedValue":
      return `${prefix}option ${error.flag} does not take a value (got ${JSON.stringify(error.value)})\n`;
    case "requiredMissing":
      return `${prefix}missing required argument: ${error.name}\n`;
    case "invalidChoice":
      return `${prefix}invalid value ${JSON.stringify(error.value)} for ${error.name}; choose from ${error.choices.join(", ")}\n`;
  }
}

/** Extra tokens a command's own spec never declared — always reported
 * against the top-level banner, since that is the level that ultimately
 * gives up on them. */
export function unexpectedArguments(tokens: readonly string[]): string {
  const quoted = tokens.map((token) => JSON.stringify(token));
  const message =
    quoted.length === 1
      ? `unexpected argument ${quoted.join(", ")}`
      : `unexpected arguments: ${quoted.join(", ")}`;
  return `${TOP_LEVEL.banner}lohra: error: ${message}\n`;
}

export function invalidTopLevelChoice(value: string, choices: readonly string[]): string {
  return `${TOP_LEVEL.banner}lohra: error: unknown command ${JSON.stringify(value)}; available commands: ${choices.join(", ")}\n`;
}

/** When the first argument doesn't resolve to a known command, scan forward
 * for the first token that isn't option-shaped and treat it as the
 * attempted command name (an "unknown command" error); if every token looks
 * like an option, there is no command candidate at all and every token is
 * reported as an unexpected argument instead — measured against `lohra
 * --frobnicate` (solo, unexpected), `lohra --profile foo` (unknown command
 * "foo", not "unexpected --profile"), and `lohra --frobnicate extra1
 * extra2` (unknown command "extra1"). A flag appearing before a VALID
 * command name is not handled — cli.ts's dispatch only ever inspects
 * `argv[0]` directly, and no case exercises that combination. */
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

function flagDescription(flag: FlagSpec): string {
  const description = FLAG_HELP[flag.name];
  if (description === undefined) {
    throw new Error(`missing help text for flag ${flag.name} — add it to FLAG_HELP in arg-spec.ts`);
  }
  return description;
}

/** Renders `--help`/`-h` for one command: its usage banner, a one-line
 * summary, an optional "commands:" section (for a dispatcher command like
 * `tiers` or `workflow`, one line per sub-action), and an "options:"
 * section with one line per declared flag. Every flag must have an entry in
 * `FLAG_HELP` — a missing one is a programmer error and throws rather than
 * printing a blank description. */
export function renderHelp(
  commandLevel: Level,
  spec: CommandSpec,
  summary: string,
  subcommands?: Readonly<Record<string, string>>,
): string {
  const sections = [commandLevel.banner.trimEnd(), "", summary];
  if (subcommands !== undefined) {
    sections.push("", "commands:");
    for (const [name, description] of Object.entries(subcommands)) {
      sections.push(`  ${name.padEnd(12)}${description}`);
    }
  }
  if (spec.flags.length > 0) {
    sections.push("", "options:");
    for (const flag of spec.flags) {
      sections.push(`  ${flag.name.padEnd(20)}${flagDescription(flag)}`);
    }
  }
  return `${sections.join("\n")}\n`;
}
