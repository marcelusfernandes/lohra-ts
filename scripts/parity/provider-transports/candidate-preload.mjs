import { NativeChatHttpPort } from "../../../dist/transports/index.js";
import process from "node:process";
import { URL } from "node:url";

const original = NativeChatHttpPort.prototype.post;
NativeChatHttpPort.prototype.post = function redirected(request) {
  const target = process.env.LOHRA_T10_LOOPBACK;
  if (!target) throw new Error("T10_LOOPBACK_MISSING");
  const source = new URL(request.url);
  const path = source.pathname.endsWith("/responses")
    ? "/responses"
    : source.pathname.endsWith("/messages")
      ? "/v1/messages"
      : "/v1/chat/completions";
  return original.call(this, { ...request, url: new URL(path, target).href });
};
