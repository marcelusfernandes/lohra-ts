import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

export function installNetworkSentinel() {
  let attempts = 0;
  const originals = [];
  const block = (target, key) => {
    const original = target[key];
    originals.push([target, key, original]);
    Reflect.set(target, key, (..._args) => {
      attempts += 1;
      throw new Error("NETWORK_DISABLED");
    });
  };
  if (typeof globalThis.fetch === "function") block(globalThis, "fetch");
  block(dns, "lookup");
  block(dns, "resolve");
  block(dns.promises, "lookup");
  block(dns.promises, "resolve");
  block(net, "connect");
  block(net, "createConnection");
  block(net.Socket.prototype, "connect");
  block(http, "request");
  block(https, "request");
  syncBuiltinESMExports();
  return Object.freeze({
    attempts: () => attempts,
    restore: () => {
      for (const [target, key, value] of originals.reverse()) Reflect.set(target, key, value);
      syncBuiltinESMExports();
    },
  });
}
