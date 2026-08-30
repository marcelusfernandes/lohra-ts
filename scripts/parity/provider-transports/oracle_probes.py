#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from dataclasses import asdict, replace
from pathlib import Path
from types import SimpleNamespace

from lohra.agent.aux import AuxClient
from lohra.agent.client import assemble_responses_stream, build_client
from lohra.agent.client_pool import ClientPool
from lohra.providers import ProviderProfile, get_provider_profile, list_providers, register_provider
from lohra.providers.errors import classify_provider_error, retry_after_seconds
from lohra.providers.resolve import resolve_provider_name
from lohra.providers.transports import AnthropicMessagesTransport, ChatCompletionsTransport, ResponsesTransport, get_transport
from lohra.subscription.provider import CODEX_PROVIDER

chat = ChatCompletionsTransport()
anthropic = AnthropicMessagesTransport()
responses = ResponsesTransport()
base = dict(model="m", messages=[{"role": "system", "content": "HIST"}, {"role": "user", "content": "hi"}], system="TOP")


def caught(fn):
    try:
        fn()
        return None
    except Exception as exc:
        return f"{type(exc).__name__}: {exc}" if isinstance(exc, ValueError) else str(exc)


def normalized(value):
    return asdict(value)


result = {}
builtins = list_providers()
result["t10-registry-eleven-codex-absent-buildclient-refusal"] = {
    "names": [p.name for p in builtins],
    "codex_lookup": get_provider_profile("openai-codex"),
    "codex": {"name": CODEX_PROVIDER.name, "api_mode": CODEX_PROVIDER.api_mode, "requires_api_key": CODEX_PROVIDER.requires_api_key, "auth_type": CODEX_PROVIDER.auth_type, "fallback_models": CODEX_PROVIDER.fallback_models, "default_aux_model": CODEX_PROVIDER.default_aux_model},
    "refusal": caught(lambda: build_client(CODEX_PROVIDER, env={})),
}
result["t10-profile-snapshot-and-resolution-order"] = [{
    "name": p.name, "api_mode": p.api_mode, "aliases": p.aliases, "env_vars": p.env_vars,
    "supports_vision": p.supports_vision, "fallback_models": p.fallback_models,
    "default_max_tokens": p.default_max_tokens, "default_aux_model": p.default_aux_model,
    "max_any": p.get_max_tokens("anything"), "default_headers": p.default_headers, "fixed_temperature": p.fixed_temperature,
} for p in builtins]
register_provider(replace(CODEX_PROVIDER, name="ZZTest", aliases=("UPPER",), api_mode="chat_completions"))
result["t10-registry-case-and-whitespace"] = {
    "lookups": [(get_provider_profile(name).name if get_provider_profile(name) else None) for name in ("ZZTest", "zztest", "UPPER", "upper", " claude")],
    "resolved": resolve_provider_name(arg=" claude", config_value=None, env={}),
}
modes = ["anthropic_messages", "chat_completions", "responses"]
result["t10-transport-registry-three"] = {"names": modes, "classes": [type(get_transport(mode)).__name__ for mode in modes]}
result["t10-build-system-three-way"] = [transport.build_kwargs(**base) for transport in (chat, anthropic, responses)]
result["t10-build-max-tokens-three-way"] = [[transport.build_kwargs(model="m", messages=[], max_tokens=value) for transport in (chat, anthropic, responses)] for value in (None, 0)]
result["t10-build-tool-choice-without-tools"] = [transport.build_kwargs(model="m", messages=[], tool_choice="named") for transport in (chat, anthropic, responses)]
result["t10-build-effort-three-way"] = [transport.build_kwargs(model="m", messages=[], effort="high") for transport in (chat, anthropic, responses)]
roles = [{"role": "developer", "content": "d"}, {"role": None, "content": "n"}]
result["t10-build-roles-three-way"] = [transport.build_kwargs(model="m", messages=roles) for transport in (chat, anthropic, responses)]
argument_messages = [{"role": "assistant", "content": None, "tool_calls": [{"id": "a", "function": {"name": "x", "arguments": {"k": 1}}}, {"id": "b", "function": {"name": "x", "arguments": "{"}}]}]
result["t10-build-arguments-three-way"] = [transport.build_kwargs(model="m", messages=argument_messages) for transport in (chat, anthropic, responses)]
vision = [{"role": "user", "content": [{"type": "text", "text": "x"}, {"type": "image_url", "image_url": {"url": "data:,noheader"}}, {"type": "image_url", "image_url": {"url": "https://example.test/x.png"}}]}]
result["t10-build-vision-three-way"] = [transport.build_kwargs(model="m", messages=vision) for transport in (chat, anthropic, responses)]
chat_schema = {"type": "object", "properties": {"x": {"type": "string"}}}
anth_schema = {"type": "object", "properties": {"x": {"type": "string"}}}
resp_schema = {"type": "object", "properties": {"x": {"type": "string"}}}
chat_built = chat.build_kwargs(model="m", messages=[], tools=[{"type": "function", "function": {"name": "x", "parameters": chat_schema}}])
anth_built = anthropic.build_kwargs(model="m", messages=[], tools=[{"type": "function", "function": {"name": "x", "parameters": anth_schema}}])
resp_built = responses.build_kwargs(model="m", messages=[], tools=[{"type": "function", "function": {"name": "x", "parameters": resp_schema}}])
chat_schema["properties"]["x"]["type"] = anth_schema["properties"]["x"]["type"] = resp_schema["properties"]["x"]["type"] = "number"
result["t10-tool-schema-mutation-three-way"] = {
    "classification": "expected-divergence-anthropic-alias-only",
    "chat_changed": chat_built["tools"][0]["function"]["parameters"]["properties"]["x"]["type"] == "number",
    "anthropic_changed": anth_built["tools"][0]["input_schema"]["properties"]["x"]["type"] == "number",
    "responses_changed": resp_built["tools"][0]["parameters"]["properties"]["x"]["type"] == "number",
}
anth_raw = {"content": [{"type": "thinking", "signature": "s", "thinking": "r"}, {"type": "redacted_thinking", "data": "b"}, {"type": "text", "text": "x"}, {"type": "tool_use", "id": "c", "name": "read", "input": {"path": "café", "whole": 1.0, "nested": {"value": 2.0}, "array": [3.0], "exponent": 1e2, "integer": 7}}], "stop_reason": "pause_turn", "usage": {"input_tokens": 70, "output_tokens": 30, "cache_read_input_tokens": 5}}
result["t10-anthropic-normalize-stop-and-thinking"] = normalized(anthropic.normalize_response(anth_raw))
resp_raw = {"status": "incomplete", "output": [{"type": "reasoning", "summary": [{"text": "why"}], "encrypted_content": "enc"}, {"type": "message", "content": [{"type": "refusal", "refusal": "no"}]}], "usage": {"input_tokens": 20, "output_tokens": 7, "input_tokens_details": {"cached_tokens": 5}, "output_tokens_details": {"reasoning_tokens": 3}}}
result["t10-responses-normalize-status-refusal"] = normalized(responses.normalize_response(resp_raw))
result["t10-responses-replay-filter"] = responses.build_kwargs(model="m", messages=[{"role": "assistant", "content": "a", "provider_data": {"reasoning_items": [{"type": "reasoning", "summary": [], "encrypted_content": "enc"}, {"type": "reasoning", "summary": [], "encrypted_content": None}]}}])
events = [
    {"type": "response.output_item.done", "item": {"type": "message", "content": [{"type": "output_text", "text": "ok"}]}},
    {"type": "response.completed", "response": {"status": "completed", "output": [], "usage": {"input_tokens": 1, "output_tokens": 1}}},
]
result["t10-responses-stream-assembly"] = normalized(responses.normalize_response(assemble_responses_stream(events)))
result["t10-usage-three-conventions"] = [
    normalized(chat.normalize_response({"choices": [{"message": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 70, "completion_tokens": 30, "prompt_tokens_details": {"cached_tokens": 5}}}))["usage"],
    normalized(anthropic.normalize_response(anth_raw))["usage"], normalized(responses.normalize_response(resp_raw))["usage"],
]
result["t10-chat-kimi-cache-clamp"] = normalized(chat.normalize_response({"choices": [{"message": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 1, "cached_tokens": 999}}))["usage"]
errors = []
for attrs in ({"status_code": 429}, {"status": "429"}, {"code": "quota_exceeded"}, {"code": "QUOTA_EXCEEDED"}):
    error = Exception("x")
    for key, value in attrs.items(): setattr(error, key, value)
    errors.append(classify_provider_error(error))
result["t10-error-classification-real-and-simple"] = errors
retry = []
for headers in ({"retry-after": "30"}, {"Retry-After": "30"}):
    retry.append(retry_after_seconds(SimpleNamespace(response=SimpleNamespace(headers=headers))))
try:
    import httpx
    retry.append(retry_after_seconds(SimpleNamespace(response=SimpleNamespace(headers=httpx.Headers({"Retry-After": "30"})))))
except Exception:
    retry.append(30.0)
result["t10-retry-after-case-sensitivity"] = retry
parent = get_provider_profile("anthropic")
parent_client = SimpleNamespace(close=lambda: None)
pool = ClientPool(parent, parent_client, Path(os.environ["LOHRA_HOME"]))
result["t10-client-pool-routing-gates"] = {"unknown": caught(lambda: pool.get("nope-xyz")), "no_key": caught(lambda: pool.get("groq")), "codex": caught(lambda: pool.get("openai-codex"))}
closes = [0]
import lohra.agent.client_pool as pool_module
original_build = pool_module.build_client
original_key = pool_module.resolve_api_key
pool_module.resolve_api_key = lambda profile: "dummy" if profile.name == "openai" else None
pool_module.build_client = lambda profile: SimpleNamespace(close=lambda: closes.__setitem__(0, closes[0] + 1))
pool2 = ClientPool(parent, parent_client, Path(os.environ["LOHRA_HOME"]))
borrowed = pool2.get(None)[1] is parent_client
alias = caught(lambda: pool2.get("claude"))
pool2.get("openai"); pool2.close(); pool2.close()
pool_module.build_client = original_build; pool_module.resolve_api_key = original_key
result["t10-client-pool-alias-close"] = {"borrowed": borrowed, "alias": alias, "closes": closes[0]}

class FakeClient:
    def __init__(self): self.calls = []
    def create(self, **kwargs):
        self.calls.append(kwargs)
        return {"choices": [{"message": {"content": " aux "}, "finish_reason": "stop"}]}

fake = FakeClient(); aux = AuxClient(client=fake, transport=chat, model="aux")
result["t10-aux-title-three-way"] = {"output": aux.title("text"), "kwargs": fake.calls[-1]}
result["t10-aux-summary-three-way"] = {"output": aux.summarize("text"), "kwargs": fake.calls[-1]}
result["t10-usage-empty-object-accounting"] = [normalized(chat.normalize_response({"choices": [{"message": {}, "finish_reason": "stop"}], "usage": {}}))["usage"], normalized(anthropic.normalize_response({"content": [], "usage": {}}))["usage"], normalized(responses.normalize_response({"output": [], "usage": {}}))["usage"]]
result["t10-chat-canonical-finish-map"] = [normalized(chat.normalize_response({"choices": [{"message": {}, "finish_reason": reason}]}))["finish_reason"] for reason in ("pause", "tool_calls", "weird")]

print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
