// Installs the two loopback-only boundaries used by the T19 parity harness
// before the real built CLI starts: a fake provider profile and a controlled
// MCP session factory. Product registration, dispatch, tool filtering and the
// agent loop remain untouched.
import process from "node:process";

import { defaultSessionFactory } from "../../../dist/mcp/index.js";
import { registerProvider } from "../../../dist/providers/index.js";

registerProvider({
  name: "fakeprov",
  apiMode: "chat_completions",
  aliases: [],
  displayName: "T19 loopback fixture",
  description: "",
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

const fixtureRaw = process.env.T19_MCP_FIXTURE;
const fixture = JSON.parse(fixtureRaw ?? '{"servers":{}}');

class FixtureSession {
  #listCalls = 0;

  constructor(server, spec) {
    this.server = server;
    this.spec = spec;
  }

  async listTools() {
    if (this.spec.list_tools_raises) throw new Error(this.spec.list_tools_raises);
    this.#listCalls += 1;
    if (this.#listCalls > 1 && Object.hasOwn(this.spec, "refresh_tools")) {
      return [...this.spec.refresh_tools];
    }
    return [...(this.spec.tools ?? [])];
  }

  async callTool(name, args) {
    if (this.spec.call_raises) throw new Error(this.spec.call_raises);
    if (Object.hasOwn(this.spec.call_results ?? {}, name)) return this.spec.call_results[name];
    return {
      content: [
        {
          type: "text",
          text: `served-by:${this.server}:${name}:${JSON.stringify(args)}`,
        },
      ],
      isError: false,
    };
  }

  async close() {}
}

if (fixtureRaw !== undefined) {
  defaultSessionFactory.current = async (config) => {
    const spec = fixture.servers?.[config.name];
    if (spec === undefined) throw new Error(`no fixture for MCP server '${config.name}'`);
    if (spec.connect_raises) throw new Error(spec.connect_raises);
    return new FixtureSession(config.name, spec);
  };
}
