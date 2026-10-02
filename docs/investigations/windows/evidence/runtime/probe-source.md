# Sonda W4 reproduzível

Fonte da sonda temporária executada fora do checkout, com formatação Prettier aplicada para leitura; a lógica foi preservada. Não contém tokens reais nem caminhos pessoais fixos; os quatro argumentos são o clone com `dist`, o `node.exe`, uma raiz temporária isolada e o rótulo do Node. Execute somente com stub local e porta 11434 livre; se ocupada, o bloco `serve` registra `serve-local-stub-blocked` sem parar o serviço alheio. O processo filho recebe `LOHRA_HOME` e `CODEX_HOME` temporários. O script escreve `result.json` apenas na raiz temporária fornecida.

Exemplo, após `npm ci` e `npm run build` no clone temporário do SHA:

```powershell
& $node $probe $clone $node $runRoot '20.20.2'
```

```javascript
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const [source, nodeExe, root, label] = process.argv.slice(2);
if (!source || !nodeExe || !root || !label) throw new Error("usage: probe source node root label");
fs.mkdirSync(root, { recursive: true });
const home = path.join(root, "home"),
  codex = path.join(root, "codex"),
  profile = path.join(root, "user");
for (const p of [home, codex, profile]) fs.mkdirSync(p, { recursive: true });
const toolFile = path.join(root, "tool-target.txt");
fs.writeFileSync(toolFile, "W4-FILE\n");
const systemBase = {
  PATH: process.env.PATH ?? "",
  PATHEXT: process.env.PATHEXT ?? "",
  SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
  WINDIR: process.env.WINDIR ?? "C:\\Windows",
  ComSpec: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
  TEMP: root,
  TMP: root,
  HOME: profile,
  USERPROFILE: profile,
  APPDATA: path.join(root, "AppData"),
  LOCALAPPDATA: path.join(root, "LocalAppData"),
  LOHRA_HOME: home,
  CODEX_HOME: codex,
  LOHRA_PROVIDER: "openrouter",
  OPENROUTER_API_KEY: "LOCAL-STUB-ONLY",
};
const records = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function answer(message, reason = "stop") {
  return {
    id: "stub-w4",
    object: "chat.completion",
    created: 0,
    model: "openai/gpt-4o-mini",
    choices: [{ index: 0, message, finish_reason: reason }],
    usage: { prompt_tokens: 17, completion_tokens: 7, total_tokens: 24 },
  };
}
function chunk(delta, reason = null) {
  return {
    id: "stub-w4",
    object: "chat.completion.chunk",
    created: 0,
    model: "openai/gpt-4o-mini",
    choices: [{ index: 0, delta, finish_reason: reason }],
  };
}
function sse(res, delta, reason) {
  res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: null }))}\n\n`);
  res.write(`data: ${JSON.stringify(chunk(delta))}\n\n`);
  res.write(`data: ${JSON.stringify(chunk({}, reason))}\n\n`);
  res.write(
    `data: ${JSON.stringify({ ...chunk({}), choices: [], usage: { prompt_tokens: 17, completion_tokens: 7, total_tokens: 24 } })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
}
const stub = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  let raw = "";
  for await (const part of req) raw += part;
  let b;
  try {
    b = JSON.parse(raw);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const messages = Array.isArray(b.messages) ? b.messages : [];
  const sys = String(messages.find((m) => m.role === "system")?.content ?? "");
  const latest = [...messages].reverse().find((m) => m.role === "user");
  const user = String(latest?.content ?? "");
  const isSummary = sys.includes("You are compacting a long conversation");
  const isTool = user.includes("W4_TOOL") && !messages.some((m) => m.role === "tool");
  const isHold = user.includes("W4_HOLD");
  records.push({
    summary: isSummary,
    tool: isTool,
    hold: isHold,
    stream: b.stream === true,
    roles: messages.map((m) => m.role).join(","),
    systemHash: crypto.createHash("sha256").update(sys).digest("hex").slice(0, 12),
    userTag: user.slice(0, 16),
  });
  if (isHold) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify(chunk({ role: "assistant", content: null }))}\n\n`);
    return;
  }
  let message,
    reason = "stop",
    delta;
  if (isSummary) {
    message = { role: "assistant", content: "COMPACT-SUMMARY" };
    delta = { content: "COMPACT-SUMMARY" };
  } else if (isTool) {
    const tc = {
      id: "call_w4_1",
      type: "function",
      function: { name: "read_file", arguments: JSON.stringify({ path: toolFile }) },
    };
    message = { role: "assistant", content: null, tool_calls: [tc] };
    reason = "tool_calls";
    delta = { tool_calls: [{ index: 0, ...tc }] };
  } else {
    message = { role: "assistant", content: "STUB-FINAL" };
    delta = { content: "STUB-FINAL" };
  }
  if (b.stream === true) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, delta, reason);
  } else {
    const body = JSON.stringify(answer(message, reason));
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  }
});
await new Promise((r) => stub.listen(0, "127.0.0.1", r));
const stubPort = stub.address().port;
const env = { ...systemBase, LOHRA_PROVIDER_BASE_URL: `http://127.0.0.1:${stubPort}/v1` };
const cli = path.join(source, "dist", "cli.js");
const result = [];
function run(args, extra = {}) {
  return new Promise((resolve) => {
    const child = spawn(nodeExe, [cli, ...args], {
      cwd: source,
      env: { ...env, ...extra },
      windowsHide: true,
    });
    let stdout = "",
      stderr = "",
      done = false;
    const timer = setTimeout(() => {
      if (!done) {
        child.kill();
      }
    }, 30000);
    child.stdout.on("data", (x) => (stdout += x));
    child.stderr.on("data", (x) => (stderr += x));
    child.on("close", (code, signal) => {
      done = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}
function emit(name, value) {
  const row = { name, node: label, ...value };
  result.push(row);
  console.log(JSON.stringify(row));
}
function parseOutput(x) {
  try {
    return JSON.parse(x.stdout);
  } catch {
    return null;
  }
}
const version = await run(["--version"]);
emit("version", { exit: version.code, output: version.stdout.trim() });
const doctor = await run(["doctor", "--json"]);
emit("doctor", { exit: doctor.code, json: parseOutput(doctor) !== null });
const first = await run([
  "chat",
  "--json",
  "--provider",
  "openrouter",
  "--model",
  "openai/gpt-4o-mini",
  "W4_TOOL",
]);
const firstJson = parseOutput(first);
const sid = firstJson?.session_id;
emit("chat-tool", {
  exit: first.code,
  json: !!firstJson,
  completed: firstJson?.completed ?? null,
  session: typeof sid === "string" && sid.length > 0,
  tool: firstJson?.tool_calls?.[0]?.name ?? null,
  toolResultHasMarker: String(firstJson?.tool_calls?.[0]?.result ?? "").includes("W4-FILE"),
  upstreamCalls: records.length,
});
const sysFirst = records.find((r) => r.tool)?.systemHash;
const second =
  typeof sid === "string"
    ? await run([
        "chat",
        "--json",
        "--no-tools",
        "--provider",
        "openrouter",
        "--model",
        "openai/gpt-4o-mini",
        "--session",
        sid,
        "W4_RESUME",
      ])
    : { code: null, stdout: "", stderr: "" };
const secondJson = parseOutput(second);
const lastRec = records.at(-1);
emit("chat-resume", {
  exit: second.code,
  completed: secondJson?.completed ?? null,
  sameSession: secondJson?.session_id === sid,
  roles: lastRec?.roles ?? null,
  systemPreserved: lastRec?.systemHash === sysFirst,
});
if (typeof sid === "string" && first.code === 0 && second.code === 0) {
  for (let i = 0; i < 10; i++) {
    const x = await run([
      "chat",
      "--json",
      "--no-tools",
      "--provider",
      "openrouter",
      "--model",
      "openai/gpt-4o-mini",
      "--session",
      sid,
      `W4_FILL_${i}_` + "x".repeat(2000),
    ]);
    if (x.code !== 0) {
      emit("chat-fill-error", { index: i, exit: x.code, error: parseOutput(x)?.error ?? null });
      break;
    }
  }
  const start = records.length;
  const compact = await run(
    [
      "chat",
      "--json",
      "--no-tools",
      "--provider",
      "openrouter",
      "--model",
      "openai/gpt-4o-mini",
      "--session",
      sid,
      "W4_COMPACT",
    ],
    { LOHRA_CONTEXT_WINDOW: "17000" },
  );
  const c = parseOutput(compact);
  emit("chat-compaction", {
    exit: compact.code,
    completed: c?.completed ?? null,
    compaction: c?.compaction ?? null,
    summaryCalls: records.slice(start).filter((r) => r.summary).length,
    stderrEvent: compact.stderr.includes("session.compacted"),
    error: c?.error ?? null,
  });
}
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
function launch(args, extra = {}) {
  const child = spawn(nodeExe, [cli, ...args], {
    cwd: source,
    env: { ...env, ...extra },
    windowsHide: true,
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (x) => (stdout += x));
  child.stderr.on("data", (x) => (stderr += x));
  const closed = new Promise((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal })),
  );
  return {
    child,
    closed,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}
async function until(check, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await wait(75);
  }
  throw new Error("WAIT_TIMEOUT");
}
async function stopProcess(proc) {
  if (!proc) return null;
  proc.child.kill("SIGTERM");
  let done = await Promise.race([proc.closed, wait(5000).then(() => null)]);
  if (done === null) {
    proc.child.kill();
    done = await Promise.race([proc.closed, wait(2000).then(() => null)]);
  }
  return done;
}
async function request(url, options) {
  try {
    const response = await fetch(url, options);
    const body = await response.text();
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      data = null;
    }
    return { status: response.status, data, body: body.slice(0, 100) };
  } catch (e) {
    return { error: e?.name ?? "ERROR" };
  }
}
let dash = null,
  serve = null,
  serveStub = null;
try {
  const port = await freePort();
  dash = launch([
    "dashboard",
    "--provider",
    "openrouter",
    "--model",
    "openai/gpt-4o-mini",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--no-open",
  ]);
  const boot = await until(() => (dash.stderr.includes("WebSocket:") ? dash.stderr : null));
  const token = /token=([^\s]+)/.exec(boot)?.[1];
  const noauth = await request(`http://127.0.0.1:${port}/api/status`);
  const auth = await request(`http://127.0.0.1:${port}/api/status`, {
    headers: { "X-Lohra-Session-Token": token ?? "" },
  });
  emit("gateway-http-auth", {
    started: !!token,
    noToken: noauth.status,
    withToken: auth.status,
    statusOk: auth.data?.ok ?? null,
  });
  const WebSocket = createRequire(path.join(source, "package.json"))("ws");
  const bad = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=wrong`);
  const badClose = await Promise.race([
    new Promise((resolve) => bad.on("close", (code) => resolve(code))),
    wait(5000).then(() => null),
  ]);
  emit("gateway-ws-auth", { badCloseCode: badClose });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${token}`);
  const queue = [];
  ws.on("message", (raw) => {
    try {
      queue.push(JSON.parse(String(raw)));
    } catch {}
  });
  await until(() => ws.readyState === WebSocket.OPEN);
  await until(() => queue.some((f) => f.params?.type === "gateway.ready"));
  const take = async (pred) => {
    const end = Date.now() + 12000;
    while (Date.now() < end) {
      const i = queue.findIndex(pred);
      if (i >= 0) return queue.splice(i, 1)[0];
      await wait(50);
    }
    throw new Error("WS_FRAME_TIMEOUT");
  };
  const rpc = (id, method, params) =>
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  rpc("create", "session.create", {});
  const created = await take((f) => f.id === "create");
  const gs = created.result?.session_id;
  await take((f) => f.params?.type === "session.info");
  rpc("turn1", "prompt.submit", { session_id: gs, text: "W4_TOOL" });
  const accepted = await take((f) => f.id === "turn1");
  const events = [];
  while (true) {
    const f = await take((f) => f.method === "event");
    events.push(f.params?.type);
    if (f.params?.type === "message.complete") {
      emit("gateway-tool-events", {
        accepted: accepted.result?.status,
        completeStatus: f.params?.payload?.status,
        events,
        toolMarker: records.some((r) => r.tool && r.stream),
      });
      break;
    }
  }
  const interruptWs = new WebSocket(`ws://127.0.0.1:${port}/api/ws?token=${token}`);
  const interruptQueue = [];
  interruptWs.on("message", (raw) => {
    try {
      interruptQueue.push(JSON.parse(String(raw)));
    } catch {}
  });
  await until(() => interruptWs.readyState === WebSocket.OPEN);
  rpc("hold", "prompt.submit", { session_id: gs, text: "W4_HOLD" });
  await take((f) => f.id === "hold");
  await until(() => records.some((r) => r.hold));
  interruptWs.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "interrupt",
      method: "session.interrupt",
      params: { session_id: gs },
    }),
  );
  const interruptedRpc = await until(() => interruptQueue.find((f) => f.id === "interrupt"));
  const interruptedFrame = await take((f) => f.params?.type === "message.complete");
  rpc("again", "prompt.submit", { session_id: gs, text: "W4_AGAIN" });
  const acceptedAgain = await take((f) => f.id === "again");
  const completeAgain = await take((f) => f.params?.type === "message.complete");
  emit("gateway-interrupt-resume", {
    interruptOk: interruptedRpc.result?.ok ?? null,
    interrupted: interruptedFrame.params?.payload?.status,
    acceptedAgain: acceptedAgain.result?.status,
    completedAgain: completeAgain.params?.payload?.status,
  });
  ws.close();
  interruptWs.close();
  await wait(100);
  const stopped = await stopProcess(dash);
  emit("gateway-shutdown", {
    exit: stopped?.code ?? null,
    signal: stopped?.signal ?? null,
    portClosed: (await request(`http://127.0.0.1:${port}/api/status`)).error !== undefined,
  });
  dash = null;
} catch (e) {
  emit("gateway-error", {
    kind: e?.name ?? "Error",
    message: String(e?.message ?? e).slice(0, 160),
  });
  if (dash) {
    const stopped = await stopProcess(dash);
    emit("gateway-shutdown-after-error", {
      exit: stopped?.code ?? null,
      signal: stopped?.signal ?? null,
    });
    dash = null;
  }
}
try {
  serveStub = http.createServer(stub.listeners("request")[0]);
  await new Promise((resolve, reject) => {
    serveStub.once("error", reject);
    serveStub.listen(11434, "127.0.0.1", resolve);
  });
  const port = await freePort();
  serve = launch(["serve", "--host", "127.0.0.1", "--port", String(port), "--insecure"], {
    LOHRA_PROVIDER: "ollama",
    OLLAMA_API_KEY: "LOCAL-STUB-ONLY",
  });
  await until(() => serve.stderr.includes("Lohra OpenAI server:"));
  const health = await request(`http://127.0.0.1:${port}/health`);
  const models = await request(`http://127.0.0.1:${port}/v1/models`);
  const headers = { "content-type": "application/json" };
  const chat = await request(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "W4_SERVE" }],
    }),
  });
  const resp = await request(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "openai/gpt-4o-mini", input: "W4_SERVE_RESPONSES" }),
  });
  emit("serve-routes", {
    health: health.status,
    healthOk: health.data?.ok ?? null,
    models: models.status,
    modelCount: models.data?.data?.length ?? null,
    chat: chat.status,
    chatText: chat.data?.choices?.[0]?.message?.content ?? null,
    responses: resp.status,
    responsesStatus: resp.data?.status ?? null,
    responsesError: resp.data?.error?.type ?? null,
  });
  const busy = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const busyPort = busy.address().port;
  const blocked = await run(
    ["serve", "--host", "127.0.0.1", "--port", String(busyPort), "--insecure"],
    { LOHRA_PROVIDER: "ollama", OLLAMA_API_KEY: "LOCAL-STUB-ONLY" },
  );
  emit("serve-occupied", {
    exit: blocked.code,
    addressInUse: blocked.stderr.includes("already in use"),
  });
  await new Promise((r) => busy.close(r));
  const stopped = await stopProcess(serve);
  emit("serve-shutdown", {
    exit: stopped?.code ?? null,
    signal: stopped?.signal ?? null,
    portClosed: (await request(`http://127.0.0.1:${port}/health`)).error !== undefined,
  });
  serve = null;
} catch (e) {
  emit(e?.code === "EADDRINUSE" ? "serve-local-stub-blocked" : "serve-error", {
    kind: e?.code ?? e?.name ?? "Error",
    message: String(e?.message ?? e).slice(0, 160),
  });
  if (serve) {
    const stopped = await stopProcess(serve);
    emit("serve-shutdown-after-error", {
      exit: stopped?.code ?? null,
      signal: stopped?.signal ?? null,
    });
    serve = null;
  }
} finally {
  if (serveStub) {
    serveStub.closeAllConnections();
    await new Promise((r) => serveStub.close(r));
    serveStub = null;
  }
}
stub.closeAllConnections();
await new Promise((r) => stub.close(r));
const evidence = {
  environment: {
    node: label,
    sha: "fa8aa4a572a8d84c3eea128a7ce67ab4eac796e1",
    isolation: "LOHRA_HOME,CODEX_HOME,HOME,USERPROFILE temp; local stub only",
  },
  results: result,
  requests: records,
};
fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(evidence, null, 2));
process.exit(0);
```
