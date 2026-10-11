const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const os = require("node:os");
const pty = require(process.env.PROBE_NODE_PTY);
const WebSocket = require(process.env.PROBE_WS);
const repo = process.env.PROBE_REPO;
const node = process.env.PROBE_NODE;
if (!repo || !node) throw new Error("PROBE_ENV_REQUIRED");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lohra-730-ws-"));
for (const part of ["home", "codex", "appdata", "localappdata", "temp"])
  fs.mkdirSync(path.join(root, part));
const env = {
  SystemRoot: process.env.SystemRoot || "C:\\Windows",
  WINDIR: process.env.WINDIR || "C:\\Windows",
  ComSpec: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
  PATH: process.env.PATH || "",
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
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function port() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function main() {
  const p = await port();
  let output = "";
  let exit = null;
  let child = null;
  let ws = null;
  const result = {
    sha: process.env.PROBE_SHA,
    node: process.version,
    mechanism: "conpty_ctrlc_with_active_ws",
  };
  try {
    child = pty.spawn(
      node,
      [
        path.join(repo, "dist/cli.js"),
        "dashboard",
        "--host",
        "127.0.0.1",
        "--port",
        String(p),
        "--insecure",
        "--provider",
        "ollama",
        "--no-open",
      ],
      { name: "xterm-256color", cols: 80, rows: 24, cwd: repo, env },
    );
    child.onData((data) => (output = (output + data).slice(-3000)));
    const exited = new Promise((resolve) =>
      child.onExit(({ exitCode, signal }) => {
        exit = { exitCode, signal: signal ?? null };
        child.kill();
        resolve();
      }),
    );
    result.pid = child.pid;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${p}/api/status`, {
          signal: AbortSignal.timeout(300),
        });
        await r.body?.cancel();
        if (r.status === 200) {
          ready = true;
          break;
        }
      } catch {}
      await delay(50);
    }
    result.httpReady = ready;
    if (!ready) throw new Error("HTTP_READY_TIMEOUT");
    ws = new WebSocket(`ws://127.0.0.1:${p}/api/ws`);
    await Promise.race([
      new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      }),
      delay(4000).then(() => {
        throw new Error("WS_OPEN_TIMEOUT");
      }),
    ]);
    result.wsOpen = true;
    child.write("\x03");
    await Promise.race([exited, delay(2500)]);
    result.exitWhileWsOpen = exit;
    ws.close();
    await Promise.race([new Promise((resolve) => ws.once("close", resolve)), delay(3000)]);
    result.wsClosed = ws.readyState === WebSocket.CLOSED;
    await Promise.race([exited, delay(3000)]);
    result.exitAfterWsClose = exit;
    if (!exit) child.kill();
    const state = path.join(root, "home", "state.db");
    result.stateExisted = fs.existsSync(state);
    result.stateRemovable = false;
    if (result.stateExisted) {
      try {
        fs.renameSync(state, state + ".closed");
        result.stateRemovable = true;
      } catch {}
    }
    result.banner = output.includes("Lohra dashboard:");
    console.log(JSON.stringify(result));
    process.exitCode = result.exitAfterWsClose?.exitCode === 0 ? 0 : 2;
  } catch (error) {
    if (ws) ws.terminate();
    if (child) child.kill();
    console.log(
      JSON.stringify({
        ...result,
        error: error.message,
        exit,
        banner: output.includes("Lohra dashboard:"),
      }),
    );
    process.exitCode = 3;
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
}
main();
