#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scenarios");
const guard = {
  expectedCommit: "16b4785d803ad0ca364a8a67346a04f949fbf592",
  expectedVersion: "lohra 0.0.11\n",
  expectedPythonVersion: "3.12.10",
};
const environment = {
  allow: [],
  set: {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    PYTHONUTF8: "1",
    NO_COLOR: "1",
    COLUMNS: "80",
    TZ: "UTC",
    HOME: "{{home}}",
    CODEX_HOME: "{{home}}/codex",
    TMPDIR: "{{home}}/tmp",
    LOHRA_HOME: "{{profile}}",
  },
};
const capture = {
  tree: { enabled: true, root: "profile", exclude: [] },
  sqlite: [],
  events: [],
};
const scrub = { fixtureTokens: true, operatorCredentials: true };
const publicRunners = {
  oracle: { adapter: "python", executable: "oracle-lohra", prefixArgs: [], cwd: "sandbox" },
  candidate: {
    adapter: "typescript",
    executable: "node",
    prefixArgs: ["{{projectRoot}}/dist/cli.js"],
    cwd: "sandbox",
  },
};
const probeRunners = (mode, candidateMode = mode) => ({
  oracle: {
    adapter: "python",
    executable: "oracle-python",
    prefixArgs: ["{{projectRoot}}/scripts/parity/auth/oracle_driver.py", mode],
    cwd: "sandbox",
  },
  candidate: {
    adapter: "typescript",
    executable: "node",
    prefixArgs: ["{{projectRoot}}/scripts/parity/auth/candidate-driver.mjs", candidateMode],
    cwd: "sandbox",
  },
});
const comparisons = (tree = true, stdoutClass = "byte") => [
  { class: "byte", field: "process.exitCode" },
  { class: "byte", field: "process.signal" },
  { class: stdoutClass, field: "process.stdout" },
  { class: "byte", field: "process.stderr" },
  ...(tree ? [{ class: "schema", field: "tree" }] : []),
];
const baseExpectations = (exitCode) => [
  { side: "both", field: "process.exitCode", value: exitCode },
  { side: "both", field: "process.signal", value: null },
];
const fixture = (rootName, path, content) => ({ root: rootName, path, encoding: "utf8", content });
const auth = (mode = "subscription", ack = true, preference = "auto", extra = {}) =>
  JSON.stringify(
    { openai: { ...extra, auth_mode: mode, acknowledged_tos_risk: ack, preference } },
    null,
    2,
  );
const oauth = JSON.stringify(
  {
    access_token: "DUMMY-ACCESS-T05",
    refresh_token: "DUMMY-REFRESH-T05",
    account_id: "ACCT-T05-DUMMY",
    expires_at: 2000000000.0,
  },
  null,
  2,
);
const pub = ({
  id,
  argv,
  fixtures = [],
  exitCode,
  expectations = [],
  normalizations = [],
  preconditions = [],
  tree = true,
  socketSentinel = false,
}) => {
  const scenarioEnvironment = socketSentinel
    ? {
        ...environment,
        set: {
          ...environment.set,
          NODE_OPTIONS: "--require={{projectRoot}}/scripts/parity/auth/socket-sentinel.cjs",
          PYTHONPATH: "{{projectRoot}}/scripts/parity/auth/python-sentinel",
          PYTHONDONTWRITEBYTECODE: "1",
          LOHRA_SOCKET_SENTINEL: "{{profile}}/socket-sentinel.jsonl",
        },
      }
    : environment;
  const scenarioCapture = socketSentinel
    ? {
        ...capture,
        tree: { ...capture.tree, exclude: ["socket-sentinel.jsonl"] },
        events: [
          {
            name: "socketSentinel",
            root: "profile",
            path: "socket-sentinel.jsonl",
            format: "jsonl",
          },
        ],
      }
    : capture;
  return {
    schemaVersion: 1,
    id,
    description: `T05 public auth surface: ${id}`,
    argv,
    environment: scenarioEnvironment,
    preconditions,
    fixtures,
    runners: publicRunners,
    limits: { timeoutMs: 15000, maxOutputBytes: 4194304 },
    capture: scenarioCapture,
    comparisons: [
      ...comparisons(tree),
      ...(socketSentinel ? [{ class: "probe", field: "events.socketSentinel" }] : []),
    ],
    expectations: [
      ...baseExpectations(exitCode),
      ...expectations,
      ...(socketSentinel
        ? [
            { side: "both", field: "events.socketSentinel", pointer: "/exists", value: true },
            {
              side: "both",
              field: "events.socketSentinel",
              pointer: "/records",
              value: [{ kind: "armed" }],
            },
          ]
        : []),
    ],
    normalizations,
    scrub,
    oracleGuard: guard,
  };
};
const out = (pointer, value, side = "both") => ({
  side,
  field: "process.stdout",
  encoding: "utf8",
  pointer,
  value,
});
const stream = (field, value, side = "both") => ({ side, field, encoding: "utf8", value });
const closed = [{ kind: "tcp-port-closed", host: "127.0.0.1", port: 11434 }];
const tosWarning =
  "⚠️  Subscription mode uses your ChatGPT/Codex subscription via your existing Codex CLI login.\n" +
  "    This very likely VIOLATES OpenAI's consumer Terms of Service and may get your account BANNED.\n" +
  "    The endpoints are reverse-engineered and can break without notice. Use at your own risk.\n" +
  "    Lohra reads (never writes) ~/.codex/auth.json; on an expired token it asks you to refresh via Codex.\n";
const doctorPaths = [
  {
    field: "process.stdout",
    kind: "replace-runtime-path",
    source: "profile",
    replacement: "<PROFILE>",
  },
  { field: "process.stdout", kind: "replace-runtime-path", source: "home", replacement: "<HOME>" },
];
const manifests = [
  pub({
    id: "t05-auth-status-off",
    argv: ["auth", "status", "--no-input"],
    exitCode: 0,
    expectations: [out("/mode", "api_key"), out("/active", false), stream("process.stderr", "")],
  }),
  pub({
    id: "t05-auth-status-raw-mode-case",
    argv: ["auth", "status", "--no-input"],
    fixtures: [fixture("profile", "auth.json", auth("subscription", "true", "AUTO"))],
    exitCode: 0,
    expectations: [out("/mode", "subscription"), out("/active", false), out("/preference", "auto")],
  }),
  pub({
    id: "t05-auth-enable-no-input",
    argv: ["auth", "enable", "--no-input"],
    exitCode: 1,
    expectations: [stream("process.stdout", "")],
  }),
  pub({
    id: "t05-auth-enable-yes",
    argv: ["auth", "enable", "--yes"],
    exitCode: 0,
    expectations: [stream("process.stderr", tosWarning)],
  }),
  pub({
    id: "t05-auth-disable",
    argv: ["auth", "disable"],
    fixtures: [fixture("profile", "auth.json", auth("subscription", true, "subscription"))],
    exitCode: 0,
    expectations: [stream("process.stdout", "subscription mode disabled — using API key.\n")],
  }),
  pub({
    id: "t05-auth-prefer-api-key",
    argv: ["auth", "prefer", "api_key"],
    fixtures: [fixture("profile", "auth.json", auth())],
    exitCode: 0,
    expectations: [stream("process.stdout", "auth preference set to api_key.\n")],
  }),
  pub({
    id: "t05-auth-prefer-bogus",
    argv: ["auth", "prefer", "bogus"],
    exitCode: 2,
    expectations: [stream("process.stdout", "")],
  }),
  pub({
    id: "t05-auth-stray-argument",
    argv: ["auth", "enable", "subscription"],
    exitCode: 2,
    expectations: [stream("process.stdout", "")],
  }),
  pub({
    id: "t05-auth-logout-absent",
    argv: ["auth", "logout"],
    exitCode: 0,
    expectations: [stream("process.stdout", "no own login to remove.\n")],
  }),
  pub({
    id: "t05-auth-logout-present",
    argv: ["auth", "logout"],
    fixtures: [
      fixture("profile", "auth.json", auth()),
      fixture("profile", "oauth.json", oauth),
      fixture("home", "codex/auth.json", '{"tokens":{"access_token":"CODEX-DUMMY"}}'),
    ],
    exitCode: 0,
    expectations: [stream("process.stdout", "logged out (own OAuth token removed).\n")],
  }),
  pub({
    id: "t05-auth-login-no-input",
    argv: ["auth", "login", "--no-input"],
    exitCode: 2,
    expectations: [stream("process.stdout", "")],
  }),
  pub({
    id: "t05-doctor-own-login",
    argv: ["doctor", "--json"],
    fixtures: [fixture("profile", "auth.json", auth()), fixture("profile", "oauth.json", oauth)],
    exitCode: 0,
    preconditions: closed,
    expectations: [
      out("/environment/auth_route", "subscription"),
      out("/environment/usable", true),
      out("/checks/1/detail", "OpenAI/Codex subscription (opt-in, ToS-gray)"),
      out("/checks/3/detail", "own OAuth token valid until 2033-05-18 03:33"),
    ],
    normalizations: doctorPaths,
  }),
  pub({
    id: "t05-doctor-profile-divergence",
    argv: ["doctor", "--profile", "pf1", "--json"],
    fixtures: [fixture("profile", "auth.json", auth())],
    exitCode: 2,
    preconditions: closed,
    expectations: [
      out("/environment/subscription_active", false),
      out("/environment/base_subscription_active", true),
      out("/environment/subscription_divergence", true),
      out("/checks/4/detail", "pf1 has no subscription of its own — it bills a paid API key"),
    ],
    normalizations: doctorPaths,
  }),
  pub({
    id: "t05-models-openai-codex-active",
    argv: ["models", "--provider", "openai-codex", "--json"],
    fixtures: [
      fixture("profile", "auth.json", auth()),
      fixture("home", "codex/config.toml", 'model = "gpt-t05-fixture"\n'),
    ],
    exitCode: 0,
    expectations: [
      out("/providers/0/source", "config"),
      out("/providers/0/models/0", "gpt-t05-fixture"),
      out("/providers/0/total", 1),
    ],
  }),
  pub({
    id: "t05-chat-subscription-no-login",
    argv: ["chat", "fixture", "--json", "--no-input"],
    fixtures: [fixture("profile", "auth.json", auth())],
    exitCode: 2,
    expectations: [
      out("/session_id", ""),
      out("/model", "gpt-5.5"),
      out("/completed", false),
      out("/api_calls", 0),
    ],
    tree: false,
  }),
  pub({
    id: "t05-chat-preferred-inactive",
    argv: ["chat", "fixture", "--json", "--no-input"],
    fixtures: [fixture("profile", "auth.json", auth("api_key", false, "subscription"))],
    exitCode: 2,
    expectations: [out("/session_id", ""), out("/model", null), out("/api_calls", 0)],
    tree: false,
  }),
  pub({
    id: "t05-chat-prefer-api-key-note",
    argv: ["chat", "fixture", "--json", "--no-input"],
    fixtures: [fixture("profile", "auth.json", auth("subscription", true, "api_key"))],
    exitCode: 2,
    preconditions: closed,
    expectations: [
      out("/session_id", ""),
      out(
        "/error",
        "no provider configured — run `lohra init` (or `lohra doctor`); details on stderr",
      ),
      out("/api_calls", 0),
    ],
    tree: false,
  }),
  pub({
    id: "t05-serve-gate-auto",
    argv: ["serve"],
    fixtures: [fixture("profile", "auth.json", auth())],
    exitCode: 2,
    expectations: [stream("process.stdout", "")],
    socketSentinel: true,
  }),
  pub({
    id: "t05-serve-gate-api-key",
    argv: ["serve"],
    fixtures: [fixture("profile", "auth.json", auth("subscription", true, "api_key"))],
    exitCode: 2,
    expectations: [stream("process.stdout", "")],
    socketSentinel: true,
  }),
];

const probe = ({
  id,
  mode,
  candidateMode,
  fixtures = [],
  expectedExit = 0,
  expectations = [],
  tree = false,
  treeExclude = [],
}) => ({
  schemaVersion: 1,
  id,
  description: `T05 bilateral auth probe: ${id}`,
  argv: [],
  environment,
  preconditions: [],
  fixtures,
  runners: probeRunners(mode, candidateMode),
  limits: { timeoutMs: 15000, maxOutputBytes: 4194304 },
  capture: {
    ...capture,
    tree: { ...capture.tree, exclude: treeExclude },
  },
  comparisons: comparisons(tree, "probe"),
  expectations: [...baseExpectations(expectedExit), stream("process.stderr", ""), ...expectations],
  normalizations: [],
  scrub,
  oracleGuard: guard,
});
manifests.push(
  probe({
    id: "t05-store-merge-hardening",
    mode: "store-merge-hardening",
    tree: true,
    fixtures: [fixture("profile", "auth.json", '{"neighbor":{"x":1},"openai":{"future":"keep"}}')],
    expectations: [
      out("/authMode", "0600"),
      out("/oauthMode", "0600"),
      out("/future", "keep"),
      { side: "both", field: "tree", pointer: "/0/path", value: "auth.json" },
      { side: "both", field: "tree", pointer: "/0/mode", value: "0600" },
      { side: "both", field: "tree", pointer: "/1/path", value: "oauth.json" },
      { side: "both", field: "tree", pointer: "/1/mode", value: "0600" },
    ],
  }),
  probe({
    id: "t05-route-table",
    mode: "route-table",
    expectations: [
      out("/rows/5/mode", "api_key"),
      out("/rows/6/mode", "api_key"),
      out("/invalidCase/code", 2),
      out("/invalidCase/stdout", ""),
      out(
        "/invalidCase/stderr",
        "usage: lohra auth prefer <auto|subscription|api_key>\n" +
          "  auto          use the subscription when it is enabled, else an API key (default)\n" +
          "  subscription  require subscription mode (fails loudly when it is unusable)\n" +
          "  api_key       always use an API key, KEEPING the subscription opt-in on file\n",
      ),
    ],
  }),
  probe({
    id: "t05-credentials-resolution",
    mode: "credentials-resolution",
    treeExclude: ["oauth.json"],
    expectations: [
      out("/refreshed/persisted", true),
      out("/boundary/at300", true),
      out("/boundary/at301", false),
    ],
  }),
  probe({
    id: "t05-oauth-device-flow",
    mode: "oauth-device-flow",
    treeExclude: ["oauth.json"],
    expectations: [
      out("/device/interval", 5),
      out("/accountId", "ACCT-T05-DUMMY"),
      out("/handler/code", 0),
      out("/handler/active", true),
      out("/handler/own", true),
      out("/handler/requests", 3),
    ],
  }),
  probe({
    id: "t05-jwt-redaction",
    mode: "jwt-redaction",
    expectations: [out("/accountIds/0", "ACCT-TOP"), out("/boundary/at300", true)],
  }),
  probe({
    id: "t05-profile-isolation",
    mode: "profile-isolation",
    fixtures: [
      fixture("profile", "auth.json", auth()),
      fixture("profile", "oauth.json", oauth),
      fixture("profile", "profiles/p1/auth.json", auth("api_key", false, "api_key")),
      fixture("profile", "profiles/p2/auth.json", auth("subscription", true, "subscription")),
      fixture("profile", "profiles/p2/oauth.json", oauth),
      fixture("home", "codex/auth.json", '{"tokens":{"access_token":"CODEX-DUMMY"}}'),
    ],
    expectations: [
      out("/default/own", true),
      out("/p1/own", false),
      out("/p2/own", true),
      out("/codex/exists", true),
    ],
  }),
  probe({
    id: "t05-expiry-boundary-mutant",
    mode: "jwt-redaction",
    candidateMode: "expiry-mutant",
    expectations: [
      out("/boundary/at300", true, "oracle"),
      out("/boundary/at300", false, "candidate"),
    ],
  }),
);

if (manifests.length !== 26) throw new Error(`expected 26 manifests, got ${manifests.length}`);
for (const manifest of manifests)
  writeFileSync(resolve(root, `${manifest.id}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
