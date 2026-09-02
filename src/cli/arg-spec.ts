/** Declarative, per-command argument specs — a faithful transcription of
 * each subcommand's own `add_argument`/`parents=[common]` calls in the
 * oracle's `build_parser()` (backend/lohra/cli.py). This is the single
 * source `arg-parser.ts`'s shared `parseCommand()` reads from, and the only
 * thing `chat.ts` reads its flags from — so extraction and validation can
 * never independently drift the way `chat.ts`'s standalone `takesValue` set
 * once did (it was missing `--max-parallel`, a real oracle flag, and
 * carried `--temperature`, which the oracle's chat parser has never
 * declared).
 *
 * Only commands actually implemented in this TypeScript bootstrap have a
 * spec here — `dashboard`, `cron`, `workflow`, and `update` are refused
 * before dispatch (see cli.ts) and are out of scope.
 *
 * Flag declaration ORDER is byte-significant: an ambiguous-prefix error
 * (`ambiguous option: --pro could match --profile, --provider`) lists
 * candidates in this array's order, matching argparse's own declaration
 * order. Do not alphabetize. */

export interface FlagSpec {
  readonly name: string;
  readonly takesValue: boolean;
  readonly type?: "int";
}

export interface PositionalSpec {
  readonly name: string;
  readonly required: boolean;
  readonly choices?: readonly string[];
}

export interface CommandSpec {
  readonly flags: readonly FlagSpec[];
  readonly positionals: readonly PositionalSpec[];
}

const COMMON_FLAGS: readonly FlagSpec[] = [
  { name: "--profile", takesValue: true },
  { name: "--no-input", takesValue: false },
];

function spec(
  flags: readonly FlagSpec[],
  positionals: readonly PositionalSpec[] = [],
): CommandSpec {
  return { flags, positionals };
}

export const INIT_SPEC = spec(COMMON_FLAGS);

export const DOCTOR_SPEC = spec([...COMMON_FLAGS, { name: "--json", takesValue: false }]);

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
  [{ name: "prompt", required: true }],
);

// --port is a plain value flag here, not typed `int`: the oracle's own
// `serve --port <bad>` invalid-int rejection has not been measured, so
// emulating its message would risk a byte-format guess. Declared open.
export const SERVE_SPEC = spec([
  ...COMMON_FLAGS,
  { name: "--host", takesValue: true },
  { name: "--port", takesValue: true },
  { name: "--insecure", takesValue: false },
  { name: "--tools", takesValue: true },
]);

export const MODELS_SPEC = spec([
  ...COMMON_FLAGS,
  { name: "--provider", takesValue: true },
  { name: "--json", takesValue: false },
]);

// `tiers` itself takes no flags — only its `list`/`suggest` children do
// (each via its own `parents=[common]`). The dest name `tiers_cmd` and the
// choice order below are argparse's own (`add_subparsers(dest="tiers_cmd")`
// then `list`, `suggest` in declaration order) — both are byte-significant
// for the "required"/"invalid choice" error text.
export const TIERS_SPEC = spec(
  [],
  [{ name: "tiers_cmd", required: true, choices: ["list", "suggest"] }],
);
export const TIERS_LIST_SPEC = spec(COMMON_FLAGS);
export const TIERS_SUGGEST_SPEC = spec([...COMMON_FLAGS, { name: "--yes", takesValue: false }]);

// `profile`'s own parser has no `parents=[common]` in the oracle — it does
// NOT recognize `--profile`/`--no-input` at the argparse level, unlike
// every other implemented command.
export const PROFILE_SPEC = spec(
  [],
  [
    { name: "action", required: true, choices: ["list", "create"] },
    { name: "name", required: false },
  ],
);

export const AUTH_SPEC = spec(
  [...COMMON_FLAGS, { name: "--yes", takesValue: false }],
  [
    {
      name: "action",
      required: true,
      choices: ["status", "enable", "disable", "login", "logout", "prefer"],
    },
    { name: "value", required: false },
  ],
);

// `skill`'s own parser has no `parents=[common]`; its only implemented
// sub-action is `export` (dest `skill_cmd`) — anything else is left to
// cli.ts's existing "skill supports only `export`" error path, unchanged.
export const SKILL_SPEC = spec([], [{ name: "skill_cmd", required: true, choices: ["export"] }]);
export const SKILL_EXPORT_SPEC = spec(
  [{ name: "--to", takesValue: true }],
  [{ name: "name", required: true }],
);

export const WORKFLOW_SPEC = spec(COMMON_FLAGS, [
  { name: "workflow_cmd", required: true, choices: ["list", "watch", "audit"] },
]);
export const WORKFLOW_LIST_SPEC = spec([{ name: "--limit", takesValue: true, type: "int" }]);
export const WORKFLOW_WATCH_SPEC = spec(
  [
    { name: "--last", takesValue: false },
    { name: "--poll", takesValue: true },
  ],
  [{ name: "run_id", required: false }],
);
export const WORKFLOW_AUDIT_SPEC = spec(
  [
    { name: "--node", takesValue: true },
    { name: "--event", takesValue: true },
    { name: "--sub-id", takesValue: true },
    { name: "--segment-id", takesValue: true },
    { name: "--attempt", takesValue: true, type: "int" },
    { name: "--after-seq", takesValue: true, type: "int" },
    { name: "--snapshot-seq", takesValue: true, type: "int" },
    { name: "--limit", takesValue: true, type: "int" },
  ],
  [{ name: "run_id", required: true }],
);
