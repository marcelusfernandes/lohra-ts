import {
  PREFERENCES,
  TOS_WARNING,
  clearTokens,
  defaultOAuthPost,
  disable,
  enable,
  pollForTokens,
  setPreference,
  startDeviceLogin,
  status,
  subscriptionActive,
  writeTokens,
  type OAuthPost,
} from "../auth/index.js";
import { pythonJsonDumpsIndented } from "../serialization/python-json.js";

export const PREFER_USAGE =
  "usage: lohra auth prefer <auto|subscription|api_key>\n" +
  "  auto          use the subscription when it is enabled, else an API key (default)\n" +
  "  subscription  require subscription mode (fails loudly when it is unusable)\n" +
  "  api_key       always use an API key, KEEPING the subscription opt-in on file";

export interface AuthCommandOptions {
  readonly action: string;
  readonly value?: string;
  readonly assumeYes: boolean;
  readonly noInput: boolean;
  readonly home: string;
  readonly codexHome: string;
  readonly isTty: boolean;
  readonly post?: OAuthPost;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const result = (code: number, stdout = "", stderr = ""): CommandResult => ({
  code,
  stdout,
  stderr,
});

export async function runAuth(options: AuthCommandOptions): Promise<CommandResult> {
  if (options.action === "prefer") {
    if (!(PREFERENCES as readonly string[]).includes(options.value ?? ""))
      return result(2, "", `${PREFER_USAGE}\n`);
    setPreference(options.home, options.value as string);
    return result(0, `auth preference set to ${options.value as string}.\n`);
  }
  if (options.value !== undefined)
    return result(
      2,
      "",
      `lohra auth ${options.action} takes no argument (got '${options.value}').\nDid you mean:  lohra auth prefer <auto|subscription|api_key>\n`,
    );
  if (options.action === "status")
    return result(
      0,
      `${pythonJsonDumpsIndented(status(options.home, { codexHome: options.codexHome }))}\n`,
    );
  if (options.action === "disable") {
    disable(options.home);
    return result(0, "subscription mode disabled — using API key.\n");
  }
  if (options.action === "logout")
    return result(
      0,
      clearTokens(options.home)
        ? "logged out (own OAuth token removed).\n"
        : "no own login to remove.\n",
    );
  if (options.action === "login") {
    if (options.noInput)
      return result(
        2,
        "",
        "`lohra auth login` needs a terminal (it shows a code to enter in a browser, then waits). Run it interactively, or reuse the Codex CLI login: `codex login` then `lohra auth enable --yes`.\n",
      );
    let error = "";
    if (!subscriptionActive(options.home)) {
      error += `${TOS_WARNING}\n`;
      if (!options.assumeYes && !options.isTty)
        return result(
          2,
          "",
          `${error}subscription mode is opt-in and this is not a terminal, so there is no way to ask.\nAccept the risk above explicitly instead:\n  lohra auth login --yes\n  lohra auth enable --yes\n`,
        );
      if (!options.assumeYes)
        return result(1, "", `${error}\nEnable subscription mode anyway? [y/N]: `);
      enable(options.home);
    }
    const post = options.post ?? defaultOAuthPost;
    try {
      const device = await startDeviceLogin(post);
      error += `\nTo log in, open:\n  ${device.verifyUrl}\nand enter the code:\n  ${device.userCode}\n\nWaiting for authorization (Ctrl-C to cancel)...\n`;
      const tokens = await pollForTokens(device, post);
      writeTokens(options.home, tokens);
      return result(
        0,
        "logged in — Lohra now holds its own token and will refresh it automatically.\n",
        error,
      );
    } catch (caught) {
      return result(
        1,
        "",
        `${error}login failed: ${caught instanceof Error ? caught.message : String(caught)}\n`,
      );
    }
  }
  if (options.action !== "enable") return result(2, "", `${PREFER_USAGE}\n`);
  const error = `${TOS_WARNING}\n`;
  if (!options.assumeYes) {
    if (options.noInput)
      return result(
        1,
        "",
        `${error}aborted — subscription mode NOT enabled. Accepting the ToS risk non-interactively requires \`lohra auth enable --yes\`.\n`,
      );
    return result(
      1,
      "aborted — subscription mode NOT enabled.\n",
      `${error}\nEnable subscription mode anyway? [y/N]: `,
    );
  }
  enable(options.home);
  return result(
    0,
    "subscription mode enabled (OpenAI/Codex). Next, log in with one of:\n" +
      "  lohra auth login   — Lohra's own login (auto-refreshing; recommended).\n" +
      "                       On a fresh machine that one command is enough: it\n" +
      "                       asks for this acknowledgement itself.\n" +
      "  codex login        — reuse your Codex CLI login (no auto-refresh). That\n" +
      "                       reuse path has no login of its own, which is why\n" +
      "                       `lohra auth enable` still stands alone.\n",
    error,
  );
}
