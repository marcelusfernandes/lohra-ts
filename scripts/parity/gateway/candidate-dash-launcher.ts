// Launch the REAL `lohra dashboard` CLI against a loopback fake upstream.
// Mirrors oracle-dash-launcher.py's own pattern exactly: register an extra
// provider profile whose baseUrl points at a fake upstream, then invoke
// the public CLI entry point. Zero product code is touched -- registry.ts
// already exports registerProvider() as a first-class extension point,
// the same shape as the oracle's own register_provider().
import { registerProvider } from "../../../src/providers/registry.js";
import { runCli } from "../../../src/cli.js";

registerProvider({
  name: "fakeprov",
  apiMode: "chat_completions",
  aliases: [],
  displayName: "Fake loopback",
  description: "Loopback fake upstream for the T12 parity harness.",
  signupUrl: "",
  envVars: ["FAKE_API_KEY"],
  baseUrl: process.env.FAKE_BASE_URL ?? "",
  modelsUrl: "",
  requiresApiKey: true,
  supportsVision: false,
  fallbackModels: ["fake-model-a", "fake-model-b"],
  defaultMaxTokens: 8192,
  defaultAuxModel: "fake-model-a",
});

const argv = ["dashboard", "--port", process.env.LOHRA_PORT ?? "0", "--provider", "fakeprov"];
if (process.env.LOHRA_NO_OPEN === "1") argv.push("--no-open");
if (process.env.LOHRA_INSECURE === "1") argv.push("--insecure");

process.exitCode = await runCli(argv);
