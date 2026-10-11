const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const pty = require(process.env.PROBE_NODE_PTY);

const repo = process.env.PROBE_REPO;
const node = process.env.PROBE_NODE;
const command = process.env.PROBE_COMMAND;
const mechanism = process.env.PROBE_MECHANISM;
if (
  !repo ||
  !node ||
  !["serve", "dashboard"].includes(command) ||
  !["ctrlc", "sigterm"].includes(mechanism)
) {
  throw new Error("PROBE_INPUT_INVALID");
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), `lohra-730-${command}-${mechanism}-`));
for (const part of ["home", "codex", "appdata", "localappdata"])
  fs.mkdirSync(path.join(root, part));
const env = {
  SystemRoot: process.env.SystemRoot || "C:\\Windows",
  WINDIR: process.env.WINDIR || "C:\\Windows",
  ComSpec: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
  PATH: process.env.PATH || "",
  PATHEXT: process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD",
  HOME: path.join(root, "home"),
  USERPROFILE: path.join(root, "home"),
  LOHRA_HOME: path.join(root, "home"),
  CODEX_HOME: path.join(root, "codex"),
  APPDATA: path.join(root, "appdata"),
  LOCALAPPDATA: path.join(root, "localappdata"),
  TEMP: path.join(root, "temp"),
  TMP: path.join(root, "temp"),
  LOHRA_PROVIDER: "ollama",
  NO_COLOR: "1",
};
fs.mkdirSync(env.TEMP);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bounded = (promise, ms, label) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
const closedPort = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
  });

async function openPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main() {
  let stubRequests = 0;
  const stub = http.createServer((request, response) => {
    stubRequests++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      '{"choices":[{"index":0,"message":{"role":"assistant","content":"STUB"},"finish_reason":"stop"}]}',
    );
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const stubPort = stub.address().port;
  env.LOHRA_PROVIDER_BASE_URL = `http://127.0.0.1:${stubPort}/v1`;
  const port = await openPort();
  const args = [
    path.join(repo, "dist/cli.js"),
    command,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--insecure",
  ];
  if (command === "dashboard") args.push("--provider", "ollama", "--no-open");
  let child;
  let output = "";
  let exited = false;
  let outcome = null;
  const started = Date.now();
  let exitPromise;
  try {
    if (mechanism === "ctrlc") {
      child = pty.spawn(node, args, { name: "xterm-256color", cols: 80, rows: 24, cwd: repo, env });
      child.onData((data) => {
        output = (output + data).slice(-4000);
      });
      exitPromise = new Promise((resolve) =>
        child.onExit((result) => {
          exited = true;
          outcome = { exitCode: result.exitCode, signal: result.signal ?? null };
          resolve();
        }),
      );
    } else {
      child = spawn(node, args, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (chunk) => {
        output = (output + chunk.toString()).slice(-4000);
      });
      child.stderr.on("data", (chunk) => {
        output = (output + chunk.toString()).slice(-4000);
      });
      exitPromise = new Promise((resolve) =>
        child.once("close", (exitCode, signal) => {
          exited = true;
          outcome = { exitCode, signal };
          resolve();
        }),
      );
    }
    const endpoint = command === "serve" ? "/health" : "/api/status";
    let status = null;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (exited) throw new Error(`EXITED_BEFORE_READY:${JSON.stringify(outcome)}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
          signal: AbortSignal.timeout(1000),
        });
        status = response.status;
        await response.body?.cancel();
        break;
      } catch {
        await delay(50);
      }
    }
    if (status === null) throw new Error("READY_TIMEOUT");
    if (mechanism === "ctrlc") child.write("\x03");
    else child.kill("SIGTERM");
    await bounded(exitPromise, 10000, "EXIT_TIMEOUT");
    if (mechanism === "ctrlc") child.kill(); // discard ConPTY handles after child onExit
    await delay(150);
    const portClosed = await closedPort(port);
    const statePath = path.join(root, "home", "state.db");
    const stateExisted = fs.existsSync(statePath);
    let stateRemovable = null;
    if (stateExisted) {
      try {
        fs.renameSync(statePath, statePath + ".closed");
        stateRemovable = true;
      } catch {
        stateRemovable = false;
      }
    }
    let cleanup = false;
    try {
      fs.rmSync(root, { recursive: true, force: true });
      cleanup = true;
    } catch {}
    await new Promise((resolve) => stub.close(resolve));
    const observation = {
      sha: process.env.PROBE_SHA,
      node: process.version,
      command,
      mechanism,
      pid: child.pid,
      httpStatus: status,
      exit: outcome,
      portClosed,
      stateExisted,
      stateRemovable,
      cleanup,
      stubRequests,
      elapsedMs: Date.now() - started,
      banner: output.includes(command === "serve" ? "Lohra OpenAI server:" : "Lohra dashboard:"),
    };
    console.log(JSON.stringify(observation));
    process.exitCode =
      status === 200 &&
      portClosed &&
      cleanup &&
      (mechanism === "ctrlc"
        ? outcome.exitCode === 0
        : outcome.exitCode === null && outcome.signal === "SIGTERM")
        ? 0
        : 2;
  } catch (error) {
    if (child && !exited) child.kill();
    if (child && mechanism === "ctrlc")
      try {
        child.kill();
      } catch {}
    await bounded(exitPromise || Promise.resolve(), 3000, "CLEANUP_TIMEOUT").catch(() => {});
    await new Promise((resolve) => stub.close(resolve));
    console.log(
      JSON.stringify({
        sha: process.env.PROBE_SHA,
        node: process.version,
        command,
        mechanism,
        error: error.message,
        exit: outcome,
        banner: output.includes("Lohra"),
        elapsedMs: Date.now() - started,
      }),
    );
    process.exitCode = 3;
  }
}
main();
