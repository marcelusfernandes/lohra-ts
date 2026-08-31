/** Declarative, per-command argument specs — a faithful transcription of
 * each subcommand's own `add_argument`/`parents=[common]` calls in the
 * oracle's `build_parser()` (backend/lohra/cli.py). This is the single
 * source both the shared unrecognized-argument validator
 * (`arg-validation.ts`) and `chat.ts`'s own prompt/option extraction read
 * from, so the two cannot drift apart the way `chat.ts`'s standalone
 * `takesValue` set once did (it was missing `--max-parallel`, a real oracle
 * flag, and carried `--temperature`, which the oracle's `chat` parser has
 * never declared).
 *
 * Only commands actually implemented in this TypeScript bootstrap have a
 * spec here — `dashboard`, `cron`, `workflow`, and `update` are refused
 * before dispatch (see cli.ts) and are out of scope. Positional VALUES
 * (e.g. `profile`'s `action` choices, `auth`'s free-form `value`) are not
 * validated here — only how many bare (non-flag) tokens a command accepts,
 * matching what's needed to detect an unrecognized EXTRA argument. */

export interface FlagSpec {
  readonly name: string;
  readonly takesValue: boolean;
  readonly type?: "int";
}

export interface CommandSpec {
  readonly flags: readonly FlagSpec[];
  readonly positionalCount: number;
}

const COMMON_FLAGS: readonly FlagSpec[] = [
  { name: "--profile", takesValue: true },
  { name: "--no-input", takesValue: false },
];

function spec(flags: readonly FlagSpec[], positionalCount: number): CommandSpec {
  return { flags, positionalCount };
}

export const INIT_SPEC = spec(COMMON_FLAGS, 0);

export const DOCTOR_SPEC = spec([...COMMON_FLAGS, { name: "--json", takesValue: false }], 0);

export const CHAT_SPEC = spec(
  [
    ...COMMON_FLAGS,
    { name: "--model", takesValue: true },
    { name: "--provider", takesValue: true },
    { name: "--session", takesValue: true },
    { name: "--no-tools", takesValue: false },
    { name: "--yolo", takesValue: false },
    { name: "--json", takesValue: false },
    { name: "--max-parallel", takesValue: true, type: "int" },
    { name: "--max-iterations", takesValue: true, type: "int" },
  ],
  1,
);

// --port is a plain value flag here, not typed `int`: the oracle's own
// `serve --port <bad>` invalid-int rejection banner has not been measured,
// so emulating it would risk a byte-format guess. Declared open, not fixed.
export const SERVE_SPEC = spec(
  [
    ...COMMON_FLAGS,
    { name: "--host", takesValue: true },
    { name: "--port", takesValue: true },
    { name: "--insecure", takesValue: false },
    { name: "--tools", takesValue: true },
  ],
  0,
);

export const MODELS_SPEC = spec(
  [
    ...COMMON_FLAGS,
    { name: "--provider", takesValue: true },
    { name: "--json", takesValue: false },
  ],
  0,
);

// `tiers` itself takes no flags — only its `list`/`suggest` children do
// (each via its own `parents=[common]`). The top spec's single positional
// is the sub-action token; cli.ts picks the child spec from it and, for any
// action other than `list`/`suggest`, leaves validation to the existing
// `runTiers` "unknown action" error path unchanged.
export const TIERS_SPEC = spec([], 1);
export const TIERS_LIST_SPEC = spec(COMMON_FLAGS, 0);
export const TIERS_SUGGEST_SPEC = spec(
  [...COMMON_FLAGS, { name: "--yes", takesValue: false }],
  0,
);

// `profile`'s own parser has no `parents=[common]` in the oracle — it does
// NOT recognize `--profile`/`--no-input` at the argparse level, unlike
// every other implemented command.
export const PROFILE_SPEC = spec([], 2);

export const AUTH_SPEC = spec([...COMMON_FLAGS, { name: "--yes", takesValue: false }], 2);

// `skill`'s only implemented sub-action is `export`; anything else is left
// to cli.ts's existing "skill supports only `export`" error path, unchanged.
export const SKILL_EXPORT_SPEC = spec([{ name: "--to", takesValue: true }], 1);
