#!/usr/bin/env node
/* T20 candidate driver — deterministic, offline, socket-guarded observations.
 * Doubles live only at the sanctioned seams (DNS resolution, pinned connector,
 * search backend); parsing, limits, redirects, envelopes, registry and the chat
 * loop are the TS product under test. Output is byte-canonical with the oracle
 * driver (sorted keys, Python json.dumps formatting, ensure_ascii). */
import net from "node:net";
import { Buffer } from "node:buffer";
import { TextEncoder } from "node:util";
import { URL } from "node:url";
import process from "node:process";

import { ToolRegistry } from "../../../dist/tools/registry.js";
import { createBuiltinRegistry } from "../../../dist/tools/builtins.js";
import { ConversationRuntime } from "../../../dist/conversation/runtime.js";
import {
  currentSearchBackend,
  currentWebTransport,
  setWebTransport,
  setSearchBackend,
  DuckDuckGoBackend,
  parseDdgHtml,
  SearchUnavailable,
  WebError,
} from "../../../dist/web/index.js";

const scenario = process.argv[2];

const PUBLIC = "93.184.216.34";
const PUBLIC_V6 = "2606:4700:4700::1111";
const CANNED_URL_ARGS = '{"url": "http://public.test/"}';
const DDG_RESULT_HTML = [
  '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fone.test">One</a>',
  '<a class="result__snippet">The snippet</a>',
  '<a class="result__a" href="https://two.test">Two</a>',
].join("");

/* ---------- socket guard: any real egress is fatal ---------- */
const fatal = () => {
  throw new Error("EGRESS_FORBIDDEN");
};
const socketPrototype = net.Socket.prototype;
const originalConnect = Object.getOwnPropertyDescriptor(socketPrototype, "connect").value;
process.on("exit", () => {
  patch(socketPrototype, "connect", originalConnect);
});
const patch = (owner, name, value) => {
  Object.defineProperty(owner, name, { value, configurable: true });
};
patch(socketPrototype, "connect", fatal);

/* ---------- canonical JSON emitter (Python json.dumps shape) ---------- */
function escapeString(value) {
  let body = "";
  for (const character of value) {
    const code = character.codePointAt(0);
    if (character === '"') body += '\\"';
    else if (character === "\\") body += "\\\\";
    else if (character === "\n") body += "\\n";
    else if (character === "\r") body += "\\r";
    else if (character === "\t") body += "\\t";
    else if (character === "\b") body += "\\b";
    else if (character === "\f") body += "\\f";
    else if (code < 0x20 || code > 0x7e) {
      if (code > 0xffff) {
        const offset = code - 0x10000;
        const high = 0xd800 + (offset >> 10);
        const low = 0xdc00 + (offset & 0x3ff);
        body += `\\u${high.toString(16).padStart(4, "0")}\\u${low.toString(16).padStart(4, "0")}`;
      } else {
        body += `\\u${code.toString(16).padStart(4, "0")}`;
      }
    } else body += character;
  }
  return `"${body}"`;
}

function emit(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") return escapeString(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${value.map((entry) => (entry === undefined ? "null" : emit(entry))).join(", ")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    if (entries.length === 0) return "{}";
    return `{${entries.map(([key, entry]) => `${escapeString(key)}: ${emit(entry)}`).join(", ")}}`;
  }
  throw new TypeError(`unsupported observation value: ${String(value)}`);
}

/* ---------- doubles ---------- */
class Dns {
  constructor(table) {
    this.table = table;
    this.calls = [];
  }
  resolve(host) {
    this.calls.push(host);
    const ips = this.table[host];
    if (ips === undefined) throw new Error("fixture DNS failed");
    return ips.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  }
}

function makeWorld(table) {
  const dns = new Dns(table);
  const world = {
    dns,
    requests: [],
    requestBodies: [],
    authorization: [],
    served: 0,
    parserCalls: 0,
    serve: null,
    text(body, contentType = "text/plain", status = 200) {
      return () => {
        const iterator = (function* () {
          world.served += body.length;
          yield new TextEncoder().encode(body);
        })();
        return { status, headers: { "content-type": contentType }, body: iterator };
      };
    },
    redirect(location, status = 302) {
      return () => ({ status, headers: { location } });
    },
    chain(redirectCount, body = new TextEncoder().encode("arrived")) {
      return () => {
        if (world.requests.length <= redirectCount) {
          return { status: 302, headers: { location: `/h${world.requests.length + 1}` } };
        }
        return { status: 200, headers: { "content-type": "text/plain" }, body: world.chunked([body]) };
      };
    },
    chunked(chunks) {
      return (function* () {
        for (const chunk of chunks) {
          world.served += chunk.length;
          yield chunk;
        }
      })();
    },
    connector() {
      return {
        request: async (request) => {
          world.requests.push(request.url);
          world.requestBodies.push(typeof request.body === "string" ? request.body : "");
          if ((request.headers["authorization"] ?? "") !== "") world.authorization.push("present");
          const raw = world.serve(request);
          const headers = {};
          for (const [name, value] of Object.entries(raw.headers ?? {})) headers[name.toLowerCase()] = value;
          return {
            status: raw.status,
            headers,
            peer: raw.peer ?? request.allowedAddresses[0]?.address ?? "93.184.216.34",
            stream: {
              next: async () => raw.body.next(),
              cancel: async () => {},
            },
          };
        },
      };
    },
    transport() {
      return { resolver: (host) => dns.resolve(host), connector: world.connector() };
    },
    observation(result) {
      return {
        result,
        dns: [...dns.calls],
        requests: [...world.requests],
        requestBodies: [...world.requestBodies],
        authorization: [...world.authorization],
        bodyBytesRead: world.served,
        parserCalls: world.parserCalls,
      };
    },
  };
  return world;
}

class DownBackend {
  constructor(value) {
    this.value = value;
  }
  async search() {
    throw this.value;
  }
}

class RecordingBackend {
  constructor() {
    this.calls = [];
  }
  async search(query, maxResults) {
    this.calls.push([query, maxResults]);
    return Array.from({ length: 12 }, (_, index) => ({
      title: String(index),
      url: `https://${index}.test`,
      snippet: "s",
    })).slice(0, maxResults);
  }
}

async function toolFetch(world, url) {
  const registry = createBuiltinRegistry();
  const parsed = JSON.parse(await registry.dispatch("web_fetch", { url }));
  return world.observation(parsed);
}

async function toolSearch(world, args) {
  const registry = createBuiltinRegistry();
  const parsed = JSON.parse(await registry.dispatch("web_search", args));
  return world.observation(parsed);
}

import { createHash as nodeCreateHash } from "node:crypto";
function textSummaryOf(text) {
  const points = Array.from(text);
  return {
    length: points.length,
    sha256: nodeCreateHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"),
    head: points.slice(0, 16).join(""),
    tail: points.slice(-4).join(""),
  };
}

async function chatCanned(world) {
  const registry = createBuiltinRegistry();
  const previous = currentWebTransport();
  setWebTransport({ resolver: (host) => world.dns.resolve(host), connector: world.connector() });
  try {
    const memory = {
      sessions: new Map(),
      messages: new Map(),
      commits: [],
      createSession() {},
      session: () => null,
      loadMessages: (id) => memory.messages.get(id) ?? [],
      commitTurn: (commit) => {
        memory.commits.push(commit);
        memory.messages.set(commit.sessionId, commit.messages ?? []);
      },
      commitUsage() {},
      summary: () => ({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        apiCallCount: 0,
        pricedCallCount: null,
        actualCostUsd: null,
        estimatedCostUsd: null,
      }),
    };
    const usage = {
      inputTokens: 3,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    };
    const canned = (overrides) => ({
      content: null,
      finishReason: "stop",
      toolCalls: [],
      reasoning: null,
      usage,
      providerData: null,
      ...overrides,
    });
    const model = {
      requests: [],
      complete: async (request) => {
        model.requests.push(request);
        const index = model.requests.length - 1;
        if (index === 0) {
          return canned({
            finishReason: "tool_calls",
            toolCalls: [
              { id: "c1", name: "web_fetch", arguments: CANNED_URL_ARGS, providerData: null },
            ],
          });
        }
        return canned({ content: "final answer" });
      },
      close: () => {},
    };
    const runtime = new ConversationRuntime({
      repository: memory,
      transport: model,
      promptSnapshot: () => "frozen",
      toolDefinitions: registry.getDefinitions().filter((definition) =>
        ["web_fetch", "web_search"].includes(definition.function.name),
      ),
      toolDispatcher: {
        dispatch: async (call) => ({
          role: "tool",
          name: call.name,
          tool_call_id: call.id,
          content: await registry.dispatch(
            call.name,
            JSON.parse(call.arguments),
          ),
        }),
      },
      idSource: () => "session-t20",
      clock: () => 1,
    });
    const result = await runtime.runTurn({ input: "fetch example", provider: "fixture", model: "stub-model", cwd: "/tmp" });
    const resent = model.requests[1]?.messages ?? [];
    const toolMessage = resent.find((message) => message.role === "tool") ?? {};
    return {
      definitions: registry.namesInToolset("web"),
      toolCall: { id: "c1", name: "web_fetch", arguments: { url: "http://public.test/" } },
      toolResultEnvelope: JSON.parse(toolMessage.content ?? "{}"),
      resentToolMessage: toolMessage,
      finalResponse: result.response.content,
      usageTotal: {
        input_tokens: result.usageTotal?.inputTokens ?? 0,
        output_tokens: result.usageTotal?.outputTokens ?? 0,
      },
      dns: [...world.dns.calls],
      requests: [...world.requests],
      bodyBytesRead: world.served,
    };
  } finally {
    setWebTransport(previous);
  }
}

async function main() {
  let observation = {};
  const encoder = new TextEncoder();
  void encoder;

  if (scenario === "definitions") {
    const registry = createBuiltinRegistry();
    observation.definitions = registry
      .getDefinitions()
      .filter((definition) => ["web_fetch", "web_search"].includes(definition.function.name))
      .map((definition) => ({
        name: definition.function.name,
        description: definition.function.description,
        parameters: definition.function.parameters,
      }));
  } else if (scenario === "chat-canned") {
    const world = makeWorld({ "public.test": [PUBLIC] });
    world.serve = world.text("<html><body>chat body</body></html>", "text/html");
    observation = await chatCanned(world);
  } else if (scenario === "missing-arguments") {
    const rows = [];
    const world = makeWorld({ "public.test": [PUBLIC] });
    world.serve = world.text("never");
    setWebTransport(world.transport());
    const registry = createBuiltinRegistry();
    for (const url of [null, "", 0, false, [], {}]) {
      const parsed = JSON.parse(await registry.dispatch("web_fetch", url === null ? {} : { url }));
      rows.push({ input: url, result: parsed, dnsCount: world.dns.calls.length, requestCount: world.requests.length });
    }
    for (const query of [null, "", "   ", 0, false]) {
      const parsed = JSON.parse(await registry.dispatch("web_search", query === null ? {} : { query }));
      rows.push({ input: query, result: parsed, dnsCount: world.dns.calls.length, requestCount: world.requests.length });
    }
    observation.rows = rows;
  } else if (scenario === "coercions") {
    const rows = [];
    const registry = createBuiltinRegistry();
    const previousBackend = currentSearchBackend();
    try {
      for (const maximum of [null, 0, -9, 11, "7", "bad", 2.9, true, false, []]) {
        const backend = new RecordingBackend();
        setSearchBackend(backend);
        const envelope = JSON.parse(await registry.dispatch("web_search", { query: "q", max_results: maximum }));
        rows.push({
          input: maximum,
          backendQuery: backend.calls[0][0],
          backendMax: backend.calls[0][1],
          resultCount: (envelope.results ?? []).length,
          envelopeQuery: envelope.query,
        });
      }
      for (const query of [true, 7, ["x"]]) {
        const backend = new RecordingBackend();
        setSearchBackend(backend);
        const envelope = JSON.parse(await registry.dispatch("web_search", { query }));
        rows.push({
          input: query,
          backendQuery: backend.calls[0][0],
          backendMax: backend.calls[0][1],
          envelopeQuery: envelope.query,
        });
      }
    } finally {
      setSearchBackend(previousBackend);
    }
    observation.rows = rows;
  } else if (scenario === "scheme-host") {
    const rows = [];
    const world = makeWorld({});
    world.serve = world.text("never");
    setWebTransport(world.transport());
    for (const url of ["puBlic.test/x", "file:///etc/passwd", "ftp://public.test/x", "http:///path"]) {
      const row = await toolFetch(world, url);
      row.input = url;
      rows.push(row);
    }
    observation.rows = rows;
  } else if (scenario === "port-invalid") {
    const world = makeWorld({ "public.test": [PUBLIC] });
    world.serve = world.text("never");
    setWebTransport(world.transport());
    observation = await toolFetch(world, "http://public.test:bad/");
  } else if (scenario === "userinfo") {
    const rows = [];
    const world = makeWorld({ "public.test": [PUBLIC] });
    world.serve = world.text("accepted");
    setWebTransport(world.transport());
    rows.push(await toolFetch(world, "http://alice:secret@public.test/"));
    const credentialWorld = makeWorld({ "public.test": [PUBLIC] });
    credentialWorld.serve = (request) => {
      if (new URL(request.url).pathname === "/one") {
        return credentialWorld.redirect("http://carol:pw@public.test/final")();
      }
      return credentialWorld.text("accepted")();
    };
    setWebTransport(credentialWorld.transport());
    rows.push(await toolFetch(credentialWorld, "http://public.test/one"));
    observation.rows = rows;
  } else if (scenario === "dns-failures") {
    const rows = [];
    const world = makeWorld({});
    world.serve = world.text("never");
    setWebTransport(world.transport());
    rows.push(await toolFetch(world, "http://missing.test/"));
    const emptyWorld = makeWorld({ "public.test": [] });
    emptyWorld.serve = emptyWorld.text("never");
    setWebTransport(emptyWorld.transport());
    rows.push(await toolFetch(emptyWorld, "http://public.test/"));
    observation.rows = rows;
  } else if (scenario === "non-public-hostname") {
    const rows = [];
    const world = makeWorld({ "private.test": ["10.0.0.5"], "mixed.test": [PUBLIC, "10.0.0.5"] });
    world.serve = world.text("never");
    setWebTransport(world.transport());
    for (const url of ["http://private.test/", "http://mixed.test/"]) rows.push(await toolFetch(world, url));
    observation.rows = rows;
  } else if (scenario === "non-public-literals") {
    const rows = [];
    const world = makeWorld({
      "2130706433": ["127.0.0.1"],
      "0x7f000001": ["127.0.0.1"],
      "127.1": ["127.0.0.1"],
      "fe80::1": ["fe80::1"],
      "::ffff:127.0.0.1": ["::ffff:127.0.0.1"],
    });
    world.serve = world.text("never");
    setWebTransport(world.transport());
    for (const host of ["2130706433", "0x7f000001", "127.1"]) rows.push(await toolFetch(world, `http://${host}/`));
    rows.push(await toolFetch(world, "http://[fe80::1]/"));
    rows.push(await toolFetch(world, "http://[::ffff:127.0.0.1]/"));
    rows.push(await toolFetch(world, "http://10.0.0.5:8080/"));
    observation.rows = rows;
  } else if (scenario === "literal-public") {
    const rows = [];
    const world = makeWorld({ "93.184.216.34": [PUBLIC], "2606:4700:4700::1111": [PUBLIC_V6] });
    world.serve = world.text("literal ok");
    setWebTransport(world.transport());
    rows.push(await toolFetch(world, "http://93.184.216.34/"));
    rows.push(await toolFetch(world, `http://[${PUBLIC_V6}]/`));
    observation.rows = rows;
  } else if (scenario === "redirect-flow") {
    const rows = [];
    const table = { "public.test": [PUBLIC], "hop.test": [PUBLIC], "private.test": ["10.0.0.5"] };
    const cases = [
      ["relative", "/b", 302],
      ["protocol-relative", "//hop.test/c", 302],
      ["https-301", "https://hop.test/d", 301],
      ["302", "http://hop.test/d", 302],
      ["303", "http://hop.test/d", 303],
      ["307", "http://hop.test/d", 307],
      ["308", "http://hop.test/d", 308],
      ["to-private", "http://private.test/", 302],
      ["to-userinfo", "http://carol:pw@public.test/", 302],
      ["no-location", null, 302],
    ];
    for (const [name, location, status] of cases) {
      const world = makeWorld(table);
      if (location === null) {
        world.serve = () => ({ status: 302, headers: {} });
      } else {
        world.serve = () => {
          if (world.requests.length <= 1) return world.redirect(location, status)();
          return { status: 200, headers: { "content-type": "text/plain" }, body: world.chunked([new TextEncoder().encode("arrived")]) };
        };
      }
      setWebTransport(world.transport());
      const row = await toolFetch(world, "http://public.test/a");
      row.input = name;
      rows.push(row);
    }
    observation.rows = rows;
  } else if (scenario === "redirect-limits") {
    const rows = [];
    for (const [name, redirectCount] of [["four-redirects", 4], ["five-redirects", 5]]) {
      const world = makeWorld({ "public.test": [PUBLIC] });
      world.serve = world.chain(redirectCount);
      setWebTransport(world.transport());
      const row = await toolFetch(world, "http://public.test/start");
      row.input = name;
      rows.push(row);
    }
    const world = makeWorld({ "public.test": [PUBLIC] });
    world.serve = () => ({ status: 302, headers: {} });
    setWebTransport(world.transport());
    const row = await toolFetch(world, "http://public.test/start");
    row.input = "no-location";
    rows.push(row);
    observation.rows = rows;
  } else if (scenario === "fetch-bounds") {
    const rows = [];
    const multi = new Uint8Array(3_000_000);
    const bodiesBytes = [
      new Uint8Array(1_999_999).fill(120),
      new Uint8Array(2_000_000).fill(120),
      new Uint8Array(2_000_001).fill(120),
      multi,
      (() => {
        const tail = new Uint8Array(2_000_002);
        tail.fill(120, 0, 1_999_999);
        tail[1_999_999] = 0xe4;
        tail[2_000_000] = 0xb8;
        tail[2_000_001] = 0x80;
        return tail;
      })(),
    ];
    for (let index = 0; index < bodiesBytes.length; index += 1) {
      const world = makeWorld({ "public.test": [PUBLIC] });
      world.serve = () => ({ status: 200, headers: { "content-type": "text/plain" }, body: world.chunked([bodiesBytes[index]]) });
      setWebTransport(world.transport());
      const registry = createBuiltinRegistry();
      const parsed = JSON.parse(await registry.dispatch("web_fetch", { url: "http://public.test/" }));
      const text = parsed.text ?? "";
      rows.push({
        input: index,
        text: textSummaryOf(text),
        error: parsed.error,
        dnsCount: world.dns.calls.length,
        requestCount: world.requests.length,
        bodyBytesRead: world.served,
      });
    }
    observation.rows = rows;
  } else if (scenario === "content-types") {
    const rows = [];
    for (const contentType of [
      "",
      "text/plain",
      "text/html; charset=utf-8",
      "application/json",
      "application/xml",
      "application/javascript",
      "text/csv",
      "image/svg+xml",
      "application/jsonp",
      "x-anything/htmlish",
      "image/png",
      "application/octet-stream",
    ]) {
      const world = makeWorld({ "public.test": [PUBLIC] });
      world.serve = () => ({
        status: 200,
        headers: { "content-type": contentType },
        body: world.chunked([new TextEncoder().encode("body")]),
      });
      setWebTransport(world.transport());
      const row = await toolFetch(world, "http://public.test/");
      row.input = contentType === "" ? "missing" : contentType;
      rows.push(row);
    }
    const statusWorld = makeWorld({ "public.test": [PUBLIC] });
    statusWorld.serve = () => ({
      status: 500,
      headers: { "content-type": "text/plain" },
      body: statusWorld.chunked([new TextEncoder().encode("err text")]),
    });
    setWebTransport(statusWorld.transport());
    const row = await toolFetch(statusWorld, "http://public.test/");
    row.input = "status-500";
    rows.push(row);
    observation.rows = rows;
  } else if (scenario === "encoding") {
    const rows = [];
    const latinWorld = makeWorld({ "public.test": [PUBLIC] });
    latinWorld.serve = () => ({
      status: 200,
      headers: { "content-type": "text/plain; charset=iso-8859-1" },
      body: latinWorld.chunked([new Uint8Array([0xff, 0xfe])]),
    });
    setWebTransport(latinWorld.transport());
    rows.push(await toolFetch(latinWorld, "http://public.test/"));
    const invalidWorld = makeWorld({ "public.test": [PUBLIC] });
    invalidWorld.serve = () => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: invalidWorld.chunked([new Uint8Array([0x61, 0x62, 0x63, 0xff])]),
    });
    setWebTransport(invalidWorld.transport());
    rows.push(await toolFetch(invalidWorld, "http://public.test/"));
    observation.rows = rows;
  } else if (scenario === "peer-matrix") {
    const rows = [];
    const directWorld = makeWorld({ "rebind.test": [PUBLIC] });
    directWorld.serve = () => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      peer: "10.0.0.5",
      body: directWorld.chunked([new TextEncoder().encode("SIMULATED_PRIVATE_BODY")]),
    });
    setWebTransport(directWorld.transport());
    const direct = await toolFetch(directWorld, "http://rebind.test/");
    direct.input = "direct";
    rows.push(direct);
    const hopWorld = makeWorld({ "start.test": [PUBLIC], "hop.test": [PUBLIC] });
    hopWorld.serve = (request) => {
      if (new URL(request.url).host === "start.test") {
        return { status: 302, headers: { location: "http://hop.test/" }, peer: PUBLIC };
      }
      return {
        status: 200,
        headers: { "content-type": "text/plain" },
        peer: "1.2.3.4",
        body: hopWorld.chunked([new TextEncoder().encode("SIMULATED_REDIRECT_PRIVATE_BODY")]),
      };
    };
    setWebTransport(hopWorld.transport());
    const after = await toolFetch(hopWorld, "http://start.test/");
    after.input = "after-redirect";
    rows.push(after);
    observation.rows = rows;
  } else if (scenario === "search-unavailable") {
    const rows = [];
    const non200 = makeWorld({ "html.duckduckgo.com": [PUBLIC] });
    non200.serve = () => ({ status: 302, headers: { "content-type": "text/html" }, body: non200.chunked([new TextEncoder().encode("moved")]) });
    installSearchWorld(non200);
    rows.push(await toolSearch(non200, { query: "q" }));
    const transport = makeWorld({ "html.duckduckgo.com": [PUBLIC] });
    transport.serve = () => {
      throw new Error("fixture connect failed");
    };
    installSearchWorld(transport);
    rows.push(await toolSearch(transport, { query: "q" }));
    const previousBackend = currentSearchBackend();
    try {
      setSearchBackend(new DownBackend(new SearchUnavailable("fixture down")));
      rows.push(await toolSearchPlain({ query: "q" }));
      setSearchBackend(new DownBackend(new WebError("fixture web error")));
      rows.push(await toolSearchPlain({ query: "q" }));
    } finally {
      setSearchBackend(previousBackend);
    }
    observation.rows = rows;
  } else if (scenario === "ddg-flow") {
    const world = makeWorld({ "html.duckduckgo.com": [PUBLIC] });
    world.serve = () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: world.chunked([new TextEncoder().encode(DDG_RESULT_HTML)]),
    });
    installSearchWorld(world);
    observation = await toolSearch(world, { query: "fixture query", max_results: 5 });
  } else if (scenario === "ddg-empty-and-clamp") {
    const rows = [];
    const many = Array.from({ length: 12 }, (_, index) => `<a class="result__a" href="https://${index}.test">t</a>`).join("");
    for (const [name, html, maximum] of [["empty", "<p>no anchors</p>", 5], ["clamp-10", many, 5], ["clamp-3", many, 3]]) {
      const world = makeWorld({ "html.duckduckgo.com": [PUBLIC] });
      world.serve = () => ({ status: 200, headers: { "content-type": "text/html" }, body: world.chunked([new TextEncoder().encode(html)]) });
      installSearchWorld(world);
      const row = await toolSearch(world, { query: "q", max_results: maximum });
      row.input = name;
      rows.push(row);
    }
    observation.rows = rows;
  } else if (scenario === "ddg-byte-cap") {
    const rows = [];
    for (const size of [1_999_999, 2_000_000, 2_000_001]) {
      const world = makeWorld({ "html.duckduckgo.com": [PUBLIC] });
      world.serve = () => {
        const self = world;
        return {
          status: 200,
          headers: { "content-type": "text/html" },
          body: (function* () {
            let remaining = size;
            while (remaining > 0) {
              const piece = Math.min(remaining, 100_000);
              remaining -= piece;
              const buffer = new Uint8Array(piece).fill(122);
              self.served += piece;
              yield buffer;
            }
          })(),
        };
      };
      installSearchWorld(world);
      const row = await toolSearch(world, { query: "q", max_results: 5 });
      row.input = size;
      rows.push(row);
    }
    observation.rows = rows;
  } else if (scenario === "transport-failures") {
    const rows = [];
    for (const [name, message] of [
      ["connect", "fixture connect failed"],
      ["tls", "fixture TLS verification failed"],
      ["timeout", "fixture timeout after 10 seconds"],
      ["stream", "fixture stream aborted"],
    ]) {
      const world = makeWorld({ "public.test": [PUBLIC] });
      if (name === "stream") {
        world.serve = () => ({
          status: 200,
          headers: { "content-type": "text/plain" },
          body: (function* () {
            world.served += 7;
            yield new TextEncoder().encode("partial");
            throw new Error(message);
          })(),
        });
      } else {
        world.serve = () => {
          throw new Error(message);
        };
      }
      setWebTransport(world.transport());
      const row = await toolFetch(world, "http://public.test/");
      row.input = name;
      rows.push(row);
    }
    observation.rows = rows;
  } else if (scenario === "registry-boundary") {
    const registry = new ToolRegistry();
    registry.register({
      name: "boom",
      toolset: "x",
      schema: { description: "d", parameters: {} },
      handler: () => {
        const error = new Error("fixture unexpected");
        error.name = "RuntimeError";
        throw error;
      },
    });
    observation.rows = [
      { dispatch: JSON.parse(await registry.dispatch("boom", {})) },
      { unknown: JSON.parse(await registry.dispatch("missing", {})) },
    ];
  } else {
    throw new Error(`unknown scenario ${scenario}`);
  }

  process.stdout.write(`${emit(observation)}\n`);
}

function installSearchWorld(world) {
  setWebTransport({
    resolver: (host) => world.dns.resolve(host),
    connector: world.connector(),
  });
  const previousBackend = currentSearchBackend();
  void previousBackend;
  setSearchBackend(
    new DuckDuckGoBackend({
      connector: currentWebTransport().connector,
      resolver: currentWebTransport().resolver,
      clock: () => 0,
      parser: (html, maxResults) => {
        world.parserCalls += 1;
        return parseDdgHtml(html, maxResults);
      },
    }),
  );
}

async function toolSearchPlain(args) {
  const world = makeWorld({});
  const registry = createBuiltinRegistry();
  const parsed = JSON.parse(await registry.dispatch("web_search", args));
  return world.observation(parsed);
}

process.on("unhandledRejection", (error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});

await main();
