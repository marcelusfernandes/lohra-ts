const fs = require("node:fs");
const path = require("node:path");
const pty = require(process.env.PROBE_NODE_PTY);

const node = process.env.PROBE_NODE;
const marker = process.env.PROBE_MARKER;
const childSource = [
  'const fs=require("node:fs");',
  "const marker=process.env.PROBE_MARKER;",
  "const timer=setInterval(()=>{},1000);",
  'process.on("SIGINT",()=>{fs.writeFileSync(marker,"SIGINT_HANDLER");clearInterval(timer);process.exitCode=0});',
  'console.log("READY");',
].join("");

if (!node || !marker) throw new Error("PROBE_ENV_REQUIRED");
const out = [];
const started = Date.now();
let sent = false;
let settled = false;
const child = pty.spawn(node, ["-e", childSource], {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd: path.dirname(marker),
  env: {
    SystemRoot: process.env.SystemRoot || "C:\\Windows",
    WINDIR: process.env.WINDIR || "C:\\Windows",
    ComSpec: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
    PATH: process.env.PATH || "",
    PROBE_MARKER: marker,
  },
});
const timer = setTimeout(() => {
  if (settled) return;
  child.kill();
  setTimeout(() => (process.exitCode = 3), 1000);
}, 8000);
child.onData((data) => {
  out.push(data);
  if (!sent && out.join("").includes("READY")) {
    sent = true;
    setTimeout(() => child.write("\x03"), 100);
  }
});
child.onExit(({ exitCode, signal }) => {
  settled = true;
  clearTimeout(timer);
  try {
    child.kill();
  } catch (_) {}
  console.log(
    JSON.stringify({
      node: process.version,
      pid: child.pid,
      sentCtrlC: sent,
      exitCode,
      signal,
      marker: fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : null,
      elapsedMs: Date.now() - started,
      readyObserved: out.join("").includes("READY"),
    }),
  );
  process.exitCode = exitCode === 0 && fs.existsSync(marker) ? 0 : 2;
});
