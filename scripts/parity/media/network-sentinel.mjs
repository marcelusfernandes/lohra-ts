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
  // Every c-ares resolver entry point: dns.resolve*, the dns.promises mirror,
  // reverse lookups and the instance methods of BOTH dns.Resolver and
  // dns.promises.Resolver (distinct classes) — all bypass net.Socket/dgram,
  // so each must be poisoned explicitly.
  for (const target of [
    dns,
    dns.promises,
    dns.Resolver.prototype,
    dns.promises.Resolver.prototype,
  ]) {
    for (const key of Object.getOwnPropertyNames(target)) {
      if (/^(resolve|reverse|lookup)/.test(key) && typeof target[key] === "function")
        block(target, key);
    }
  }
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
