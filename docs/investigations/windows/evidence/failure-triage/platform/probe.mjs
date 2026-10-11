// #753: three independent probes. Run only with a fresh, task-owned root.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ownFile = fileURLToPath(import.meta.url);
const [scenario, rootArgument, cloneArgument] = process.argv.slice(2);

function failure(error) {
  return {
    name: error instanceof Error ? error.name : typeof error,
    code: error && typeof error === "object" && "code" in error ? error.code : null,
    syscall: error && typeof error === "object" && "syscall" in error ? error.syscall : null,
  };
}

function ownedCase(rootArgument) {
  if (!rootArgument) throw new Error("probe root required");
  const root = resolve(rootArgument);
  if (!existsSync(join(root, ".lohra-owned-platform-probe"))) {
    throw new Error("probe root lacks ownership marker");
  }
  return mkdtempSync(join(root, "case-"));
}

function readAcl(path) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-File", join(dirname(ownFile), "acl-readonly.ps1"), path],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    throw new Error(`ACL read failed: ${result.error?.code ?? String(result.status)}`);
  }
  return JSON.parse(result.stdout);
}

function permission(caseRoot) {
  const path = join(caseRoot, "dummy.txt");
  writeFileSync(path, "dummy", { mode: 0o600 });
  const modeAfterCreate = statSync(path).mode & 0o777;
  const aclAfterCreate = readAcl(path);
  const readAllowed = readFileSync(path, "utf8") === "dummy";
  writeFileSync(path, "allowed");
  const allowedWrite = readFileSync(path, "utf8") === "allowed";
  chmodSync(path, 0o400);
  const modeAfterReadOnly = statSync(path).mode & 0o777;
  const aclAfterReadOnly = readAcl(path);
  let deniedWrite = null;
  try {
    writeFileSync(path, "unexpected");
  } catch (error) {
    deniedWrite = failure(error);
  } finally {
    chmodSync(path, 0o600);
  }
  return {
    modeAfterCreate,
    readOnlyAttributeAfterCreate: aclAfterCreate.readOnlyAttribute,
    accessRuleCountAfterCreate: aclAfterCreate.accessRuleCount,
    accessRulesProtected: aclAfterCreate.accessRulesProtected,
    readAllowed,
    allowedWrite,
    modeAfterReadOnly,
    readOnlyAttributeAfterReadOnly: aclAfterReadOnly.readOnlyAttribute,
    descriptorUnchanged: aclAfterCreate.descriptorSha256 === aclAfterReadOnly.descriptorSha256,
    accessRuleCountAfterReadOnly: aclAfterReadOnly.accessRuleCount,
    deniedWrite,
    contentsAfterDeniedWrite: readFileSync(path, "utf8"),
    fileBasename: basename(path),
  };
}

function childSignal(caseRoot) {
  const marker = join(caseRoot, "handler.txt");
  const signal = process.argv[4];
  if (signal !== "SIGINT" && signal !== "SIGTERM") throw new Error("invalid child signal");
  process.on(signal, () => {
    writeFileSync(marker, signal);
    process.stdout.write("HANDLED\n");
    process.exit(0);
  });
  process.stdout.write("READY\n");
  setInterval(() => {}, 1000);
}

async function signalProbe(caseRoot, signal) {
  const child = spawn(process.execPath, [ownFile, "signal-child", caseRoot, signal], {
    cwd: caseRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const ready = await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectReady(new Error("child READY timeout"));
    }, 4000);
    const onData = () => {
      if (stdout.includes("READY\n")) {
        clearTimeout(timer);
        resolveReady(true);
      }
    };
    child.stdout.on("data", onData);
    onData();
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectReady(error);
    });
  });
  let forced = false;
  const closedPromise = new Promise((resolveClose) => {
    const timer = setTimeout(() => {
      forced = true;
      child.kill("SIGKILL");
    }, 4000);
    child.once("close", (code, closeSignal) => {
      clearTimeout(timer);
      resolveClose({ code, signal: closeSignal });
    });
  });
  const delivered = child.kill(signal);
  const closed = await closedPromise;
  const marker = join(caseRoot, "handler.txt");
  return {
    requestedSignal: signal,
    childPidRecorded: Number.isInteger(child.pid),
    ready,
    delivered,
    forced,
    close: closed,
    handlerMarker: existsSync(marker) ? readFileSync(marker, "utf8") : null,
    childStdoutMarkers: stdout.split(/\r?\n/u).filter(Boolean),
    childStderrPresent: stderr.length > 0,
  };
}

function sqlite(caseRoot, cloneArgument) {
  if (!cloneArgument) throw new Error("clone path required for SQLite addon");
  const clone = resolve(cloneArgument);
  const requireFromClone = createRequire(join(clone, "package.json"));
  const Database = requireFromClone("better-sqlite3");
  const path = join(caseRoot, "state.db");
  let db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
    db.exec("INSERT INTO probe (id) VALUES (1)");
    let whileOpen;
    try {
      rmSync(path);
      whileOpen = { removed: true, error: null };
    } catch (error) {
      whileOpen = { removed: false, error: failure(error) };
    }
    const existsAfterOpenRemoval = existsSync(path);
    db.close();
    db = null;
    let afterClose;
    try {
      if (existsSync(path)) rmSync(path);
      afterClose = { removed: !existsSync(path), error: null };
    } catch (error) {
      afterClose = { removed: false, error: failure(error) };
    }
    return {
      addonLoaded: true,
      whileOpen,
      existsAfterOpenRemoval,
      afterClose,
      remainingFiles: readdirSync(caseRoot).sort(),
    };
  } finally {
    if (db !== null && db.open) db.close();
  }
}

if (scenario === "signal-child") {
  childSignal(resolve(rootArgument));
} else {
  const caseRoot = ownedCase(rootArgument);
  const result =
    scenario === "permission"
      ? permission(caseRoot)
      : scenario === "sqlite"
        ? sqlite(caseRoot, cloneArgument)
        : scenario === "signal-int" || scenario === "signal-term"
          ? await signalProbe(caseRoot, scenario === "signal-int" ? "SIGINT" : "SIGTERM")
          : (() => {
              throw new Error("unknown scenario");
            })();
  console.log(
    JSON.stringify({ scenario, node: process.version, platform: process.platform, ...result }),
  );
}
