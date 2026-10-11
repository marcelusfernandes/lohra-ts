const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const dir = process.env.PROBE_DIR;
writeFileSync(join(dir, "middle-started"), "own-middle");
writeFileSync(
  join(dir, "middle-data.json"),
  JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    token: process.env.PROBE_TOKEN,
  }),
);
process.stdout.write("MIDDLE_STDOUT\n");
process.stderr.write("MIDDLE_STDERR\n");
const child = spawn(process.execPath, [join(dir, "child.cjs")], {
  cwd: dir,
  env: process.env,
  stdio: "inherit",
  shell: false,
});
child.on("error", (error) => {
  writeFileSync(join(dir, "middle-error"), error.code ?? error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  writeFileSync(join(dir, "middle-child-exit"), String(code));
  process.exitCode = code ?? 1;
});
