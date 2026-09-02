#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import process from "node:process";

import {
  CodexTokens,
  OAuthTokens,
  SubscriptionCredentials,
  accountIdFromToken,
  isExpired,
  oauthRefreshTokens,
  pollForTokens,
  readConfig,
  readTokens,
  resolveCredentials,
  routeFor,
  startDeviceLogin,
  writeConfig,
  writeTokens,
} from "../../../dist/auth/index.js";
import { pythonFloat, pythonJsonDumps } from "../../../dist/serialization/python-json.js";
import { runCli } from "../../../dist/cli.js";
import { runAuth } from "../../../dist/commands/auth.js";

const home = process.env.LOHRA_HOME;
const codexHome = process.env.CODEX_HOME;
const emit = (value) => process.stdout.write(`${pythonJsonDumps(value)}\n`);
const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.x`;
const mode = (path) => (statSync(path).mode & 0o777).toString(8).padStart(4, "0");
const configJSON = (value) =>
  value === null
    ? null
    : {
        auth_mode: value.authMode,
        acknowledged_tos_risk: value.acknowledgedTosRisk,
        preference: value.preference,
      };

function storeMerge() {
  writeConfig(home, { authMode: "subscription", acknowledgedTosRisk: true, preference: "auto" });
  writeTokens(
    home,
    new OAuthTokens("DUMMY-ACCESS-T05", "DUMMY-REFRESH-T05", "ACCT-T05-DUMMY", 1300),
  );
  const auth = JSON.parse(readFileSync(`${home}/auth.json`, "utf8"));
  const tokens = readTokens(home);
  emit({
    config: configJSON(readConfig(home)),
    neighbor: auth.neighbor,
    future: auth.openai.future,
    authMode: mode(`${home}/auth.json`),
    oauthMode: mode(`${home}/oauth.json`),
    oauth:
      tokens === null
        ? null
        : {
            accountId: tokens.accountId,
            expiresAt: pythonFloat(tokens.expiresAt),
            redacted: tokens.toString(),
          },
    temporary: readdirSync(home).filter((name) => name.includes(".tmp")),
  });
}

async function routeTable() {
  const rows = [];
  for (const preference of ["auto", "typo", "api_key", "subscription"])
    for (const active of [false, true])
      rows.push({ preference, active, ...routeFor(preference, active) });
  const invalidCase = { code: 0, stdout: "", stderr: "" };
  invalidCase.code = await runCli(["auth", "prefer", "AUTO"], {
    environment: { ...process.env },
    stdout: (value) => {
      invalidCase.stdout += value;
    },
    stderr: (value) => {
      invalidCase.stderr += value;
    },
    isTty: false,
  });
  emit({ invalidCase, rows });
}

async function credentialsResolution() {
  writeConfig(home, { authMode: "subscription", acknowledgedTosRisk: true, preference: "auto" });
  writeTokens(home, new OAuthTokens("OWN-ACCESS-T05", "OWN-REFRESH-T05", "ACCT-OWN-DUMMY", 1301));
  const fresh = await resolveCredentials(home, { now: 1000, codexHome });
  writeTokens(home, new OAuthTokens("OLD-ACCESS-T05", "OLD-REFRESH-T05", "ACCT-OWN-DUMMY", 1300));
  const calls = [];
  const refreshed = await resolveCredentials(home, {
    now: 1000,
    codexHome,
    oauthPost: async (url, body) => {
      calls.push({ url, keys: Object.keys(body).sort() });
      return [
        200,
        { access_token: "NEW-ACCESS-T05", refresh_token: "NEW-REFRESH-T05", expires_in: 3600 },
      ];
    },
  });
  emit({
    fresh: { accountId: fresh.accountId, baseUrl: fresh.baseUrl, headers: fresh.headers },
    refreshed: {
      accountId: refreshed.accountId,
      persisted: readTokens(home)?.refreshToken === "NEW-REFRESH-T05",
    },
    calls,
    boundary: {
      at300: isExpired(jwt({ exp: 1300 }), 1000),
      at301: isExpired(jwt({ exp: 1301 }), 1000),
    },
  });
}

async function oauthDeviceFlow() {
  const calls = [];
  const replies = [
    [200, { device_auth_id: "DEVICE", user_code: "USERCODE", interval: 0 }],
    [403, {}],
    [200, { authorization_code: "CODE", code_verifier: "VERIFIER" }],
    [
      200,
      {
        access_token: jwt({ chatgpt_account_id: "ACCT-T05-DUMMY" }),
        refresh_token: "REFRESH-T05",
        expires_in: 3600,
      },
    ],
  ];
  const post = async (url, body) => {
    calls.push({ url, keys: Object.keys(body).sort() });
    return replies.shift();
  };
  const device = await startDeviceLogin(post);
  const tokens = await pollForTokens(device, post, {
    sleep: async () => undefined,
    monotonicNow: (() => {
      let now = 0;
      return () => now++;
    })(),
  });
  let mismatch = "";
  try {
    await oauthRefreshTokens("R", async () => ({ status: 200 }));
  } catch (error) {
    mismatch = error.message;
  }
  const handlerCalls = [];
  const handlerReplies = [
    [200, { device_auth_id: "DEVICE", user_code: "USERCODE", interval: 0 }],
    [200, { authorization_code: "CODE", code_verifier: "VERIFIER" }],
    [
      200,
      {
        access_token: jwt({ chatgpt_account_id: "ACCT-T05-DUMMY" }),
        refresh_token: "REFRESH-T05",
        expires_in: 3600,
      },
    ],
  ];
  const handler = await runAuth({
    action: "login",
    assumeYes: true,
    noInput: false,
    home,
    codexHome,
    isTty: true,
    post: async (url, body) => {
      handlerCalls.push({ url, keys: Object.keys(body).sort() });
      return handlerReplies.shift();
    },
  });
  emit({
    device,
    calls,
    accountId: tokens.accountId,
    redacted: tokens.toString(),
    mismatch,
    handler: {
      code: handler.code,
      stdout: handler.stdout,
      stderr: handler.stderr,
      active: readConfig(home)?.acknowledgedTosRisk === true,
      own: readTokens(home) !== null,
      requests: handlerCalls.length,
    },
  });
}

function jwtRedaction(mutant = false) {
  const top = jwt({ chatgpt_account_id: "ACCT-TOP" });
  const nested = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "ACCT-NESTED" } });
  const org = jwt({ organizations: [{ id: "ACCT-ORG" }] });
  emit({
    boundary: {
      at299: isExpired(jwt({ exp: 1299 }), 1000),
      at300: mutant ? false : isExpired(jwt({ exp: 1300 }), 1000),
      at301: isExpired(jwt({ exp: 1301 }), 1000),
    },
    accountIds: [accountIdFromToken(top), accountIdFromToken(nested), accountIdFromToken(org)],
    repr: [
      new OAuthTokens("SECRET-A", "SECRET-R", "ACCT-T05-DUMMY", 1).toString(),
      new CodexTokens("SECRET-A", "SECRET-R", "ACCT-T05-DUMMY").toString(),
      new SubscriptionCredentials("SECRET-A", "ACCT-T05-DUMMY").toString(),
    ],
  });
}

function profileIsolation() {
  const values = {};
  for (const [name, path] of [
    ["default", home],
    ["p1", `${home}/profiles/p1`],
    ["p2", `${home}/profiles/p2`],
  ])
    values[name] = { config: configJSON(readConfig(path)), own: readTokens(path) !== null };
  values.codex = { exists: existsSync(`${codexHome}/auth.json`) };
  emit(values);
}

const selected = process.argv[2];
if (selected === "store-merge-hardening") storeMerge();
else if (selected === "route-table") await routeTable();
else if (selected === "credentials-resolution") await credentialsResolution();
else if (selected === "oauth-device-flow") await oauthDeviceFlow();
else if (selected === "jwt-redaction") jwtRedaction();
else if (selected === "expiry-mutant") jwtRedaction(true);
else if (selected === "profile-isolation") profileIsolation();
else throw new Error(`unknown auth mode ${selected}`);
