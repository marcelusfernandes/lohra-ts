/** Declarative, per-command argument specs — each subcommand's own flags
 * and positionals, declared once. This is the single source
 * `arg-validation.ts`'s shared `parseCommand()` reads from, and the only
 * thing `chat.ts` reads its flags from — so extraction and validation can
 * never independently drift the way `chat.ts`'s standalone `takesValue` set
 * once did (it was missing `--max-parallel`, a real flag, and carried
 * `--temperature`, which `chat`'s spec has never declared).
 *
 * Only commands actually implemented in this TypeScript bootstrap have a
 * spec here — `dashboard`, `cron`, `workflow`, and `update` are refused
 * before dispatch (see cli.ts) and are out of scope.
 *
 * Flag declaration ORDER is significant: an ambiguous-prefix error (e.g.
 * `option --pro is ambiguous; could match --profile, --provider`) lists
 * candidates in this array's own declaration order — a deliberate design
 * choice, not a computed sort. Do not alphabetize. */

export interface FlagSpec {
  readonly name: string;
  readonly takesValue: boolean;
  readonly type?: "int" | "float" | "finiteFloat";
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

export const DASHBOARD_SPEC = spec([
  ...COMMON_FLAGS,
  { name: "--model", takesValue: true },
  { name: "--provider", takesValue: true },
  { name: "--port", takesValue: true, type: "int" },
  { name: "--insecure", takesValue: false },
]);

export const CRON_SPEC = spec(
  [
    ...COMMON_FLAGS,
    { name: "--interval", takesValue: true, type: "int" },
    { name: "--cron", takesValue: true },
    { name: "--at", takesValue: true, type: "float" },
    { name: "--name", takesValue: true },
    { name: "--prompt", takesValue: true },
  ],
  [
    { name: "action", required: true, choices: ["list", "add", "remove", "pause", "resume"] },
    { name: "job_id", required: false },
  ],
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
// (each also accepting the common `--profile`/`--no-input` flags). The dest
// name `tiers_cmd` and the choice order below (`list` then `suggest`) are
// this command's own contract: both feed directly into the "missing
// required argument"/"invalid value" error text, so changing either
// changes user-facing output.
export const TIERS_SPEC = spec(
  [],
  [{ name: "tiers_cmd", required: true, choices: ["list", "suggest"] }],
);
export const TIERS_LIST_SPEC = spec(COMMON_FLAGS);
export const TIERS_SUGGEST_SPEC = spec([...COMMON_FLAGS, { name: "--yes", takesValue: false }]);

// `profile` does not accept the common `--profile`/`--no-input` flags,
// unlike every other implemented command — a deliberate command-specific
// choice, not an oversight.
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

// `skill` does not accept the common `--profile`/`--no-input` flags; its
// only implemented sub-action is `export` (dest `skill_cmd`) — anything
// else is left to cli.ts's existing "skill supports only `export`" error
// path, unchanged.
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
    { name: "--poll", takesValue: true, type: "finiteFloat" },
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

export const UPDATE_SPEC = spec([
  { name: "--check", takesValue: false },
  { name: "--reinstall", takesValue: false },
]);

/** One phrase per declared flag, keyed by its `--name` — read by
 * `renderHelp` in `arg-validation.ts` to print `--help`. Every flag that
 * appears in a `*_SPEC` above must have an entry here; `renderHelp` throws
 * rather than printing a blank description if one is missing. */
export const FLAG_HELP: Readonly<Record<string, string>> = {
  "--profile": "use a named profile instead of the active one",
  "--no-input": "never prompt; fail instead of asking (headless/CI)",
  "--json": "print machine-readable JSON instead of text",
  "--model": "override the model for this run",
  "--provider": "override the provider for this run",
  "--session": "resume an existing session id",
  "--no-tools": "disable tool calls for this run",
  "--yolo": "skip the tool-call confirmation prompt",
  "--max-parallel": "maximum tool calls to run at once",
  "--max-iterations": "maximum agent loop iterations",
  "--port": "TCP port to listen on",
  "--insecure": "bind without the local auth token",
  "--interval": "run every N minutes",
  "--cron": "run on a 5-field cron schedule",
  "--at": "run once, N seconds from now",
  "--name": "the job's display name",
  "--prompt": "the prompt the job sends",
  "--host": "address to bind",
  "--tools": "comma-separated list of tools to enable",
  "--yes": "assume yes to any confirmation",
  "--to": "destination directory for the export",
  "--limit": "maximum number of rows to show",
  "--last": "watch the most recent run",
  "--poll": "seconds between polls",
  "--node": "filter by node id",
  "--event": "filter by event type",
  "--sub-id": "filter by sub-run id",
  "--segment-id": "filter by segment id",
  "--attempt": "filter by attempt number",
  "--after-seq": "only events after this sequence number",
  "--snapshot-seq": "only the snapshot at this sequence number",
  "--check": "fetch and report without moving HEAD",
  "--reinstall": "run npm install when dependency files changed",
};

/** One-line summary per top-level command, read by `cli.ts` for both
 * `lohra --help` (the full command list) and `lohra <command> --help`
 * (the header line above that command's own options). */
export const COMMAND_SUMMARY: Readonly<Record<string, string>> = {
  init: "set up Lohra: pick a provider and write the profile config",
  doctor: "check whether the current profile can actually run",
  chat: "send one prompt to the agent and print the result",
  dashboard: "run the interactive terminal dashboard",
  serve: "run the OpenAI-compatible HTTP server",
  cron: "manage scheduled jobs",
  workflow: "look at workflow runs (reads the durable state; no LLM)",
  models: "list models available to the current provider",
  tiers: "list or suggest model tiers for the current provider",
  profile: "list or create named profiles",
  auth: "manage authentication for the current profile",
  skill: "export a bundled skill to a directory",
  update: "check or fast-forward the installed Lohra git checkout",
};

/** Sub-action descriptions for the dispatcher-style commands (`--help`
 * lists these under "commands:", one line each). Declared with `as const`
 * so member access (`SUBCOMMAND_HELP.tiers`) is a known property, not an
 * index-signature lookup that could be `undefined`. */
export const SUBCOMMAND_HELP = {
  cron: {
    list: "list scheduled jobs",
    add: "schedule a new job",
    remove: "delete a job",
    pause: "disable a job without deleting it",
    resume: "re-enable a paused job",
  },
  workflow: {
    list: "list workflow runs",
    watch: "follow a running workflow",
    audit: "inspect the event log of one run",
  },
  tiers: {
    list: "list configured tiers",
    suggest: "suggest tier settings based on your models",
  },
  profile: {
    list: "list existing profiles",
    create: "create a new profile",
  },
  auth: {
    status: "show the current auth state",
    enable: "turn on subscription auth",
    disable: "turn off subscription auth",
    login: "start the OAuth login flow",
    logout: "clear stored OAuth credentials",
    prefer: "set the preferred auth route",
  },
  skill: {
    export: "write a bundled skill's files to a directory",
  },
} as const;
