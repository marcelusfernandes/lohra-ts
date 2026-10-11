const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

const dir = process.env.PROBE_DIR;
writeFileSync(join(dir, "child-started"), "own-child");
process.stdout.write("CHILD_STDOUT\n");
process.stderr.write("CHILD_STDERR\n");
setTimeout(() => {
  writeFileSync(join(dir, "child-late"), "late-effect");
}, 1_500);
