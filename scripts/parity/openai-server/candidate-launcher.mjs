// Mirror of oracle-launcher.py for the candidate side: registers the same
// `fakeprov` ProviderProfile shape into the built candidate's registry
// BEFORE `dist/cli.js` (the positional Node entry point) runs its
// argv.slice(2) dispatch. Loaded via `node --import candidate-launcher.mjs
// dist/cli.js serve ...` so `process.argv[1]` is `dist/cli.js` itself and its
// own realpath self-check still fires `runCli`, exactly like a real install.
import { registerProvider } from "../../../dist/providers/index.js";
import process from "node:process";

const fallbackModels =
  process.env.LOHRA_T11_EMPTY_MODELS === "1" ? [] : ["fake-model-a", "fake-model-b"];

registerProvider({
  name: "fakeprov",
  apiMode: "chat_completions",
  aliases: [],
  displayName: "Fake loopback",
  description: "",
  signupUrl: "",
  envVars: ["FAKE_API_KEY"],
  baseUrl: process.env.FAKE_BASE_URL ?? "",
  modelsUrl: "",
  requiresApiKey: true,
  supportsVision: false,
  fallbackModels,
  defaultMaxTokens: 8192,
  defaultAuxModel: fallbackModels[0] ?? "",
});
