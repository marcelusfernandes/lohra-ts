/* eslint-disable @typescript-eslint/no-require-imports, no-undef */
const { appendFileSync } = require("node:fs");
const net = require("node:net");

const output = process.env.LOHRA_SOCKET_SENTINEL;
if (!output) throw new Error("LOHRA_SOCKET_SENTINEL is required");

const record = (kind) =>
  appendFileSync(output, `${JSON.stringify({ kind })}\n`, { encoding: "utf8" });

record("armed");

const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function sentinelListen(...args) {
  record("listen");
  return Reflect.apply(originalListen, this, args);
};
