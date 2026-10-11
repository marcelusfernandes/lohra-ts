const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

setTimeout(() => {
  writeFileSync(join(process.env.PROBE_DIR, "control-marker"), "external-control-intact");
}, 1_100);
