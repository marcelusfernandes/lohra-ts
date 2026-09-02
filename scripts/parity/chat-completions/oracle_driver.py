#!/usr/bin/env python3
from __future__ import annotations

import dataclasses
import json
import logging
import sys
from types import SimpleNamespace
from typing import Any

from lohra.agent.client import OpenAIClient, assemble_streamed_response
from lohra.providers.errors import classify_provider_error, retry_after_seconds
from lohra.providers.base import get_provider_profile, list_providers
from lohra.providers.transports.chat_completions import ChatCompletionsTransport


MODE = sys.argv[1]
TRANSPORT = ChatCompletionsTransport()


def emit(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=True, sort_keys=True))


def primitive(value: Any) -> Any:
    if dataclasses.is_dataclass(value):
        return {field.name: primitive(getattr(value, field.name)) for field in dataclasses.fields(value)}
    if isinstance(value, tuple):
        return [primitive(item) for item in value]
    if isinstance(value, list):
        return [primitive(item) for item in value]
    if isinstance(value, dict):
        return {key: primitive(item) for key, item in value.items()}
    return value


def response(finish: Any = "stop", extra: dict[str, Any] | None = None) -> dict[str, Any]:
    message = {"content": "x"}
    message.update(extra or {})
    return {"choices": [{"message": message, "finish_reason": finish}]}


def chunk(delta: dict[str, Any], finish_reason: str | None = None) -> dict[str, Any]:
    return {"choices": [{"delta": delta, "finish_reason": finish_reason}]}


def build_core() -> dict[str, Any]:
    return TRANSPORT.build_kwargs(
        model="m",
        system="TOP",
        messages=[
            {"role": "system", "content": "INLINE"},
            {"role": "weird", "content": "user"},
            {"role": "tool", "tool_call_id": "c1", "content": None},
        ],
    )


def build_boundaries() -> dict[str, Any]:
    return TRANSPORT.build_kwargs(
        model="m", messages=[], tools=[], max_tokens=0, temperature=0, effort="", tool_choice=""
    )


def build_unicode() -> dict[str, Any]:
    raw = "a\x7fb"
    return TRANSPORT.build_kwargs(
        model="m",
        messages=[{
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {"id": "s", "function": {"name": "string", "arguments": raw}},
                {"id": "o", "function": {"name": "object", "arguments": {"k": raw}}},
            ],
        }],
    )


def build_copy() -> dict[str, Any]:
    messages = [{"role": "user", "content": [{"type": "text", "text": "x"}]}]
    tools = [{"type": "function", "function": {"name": "f", "parameters": {"type": "object"}}}]
    before = json.dumps({"messages": messages, "tools": tools}, ensure_ascii=True, sort_keys=True)
    result = TRANSPORT.build_kwargs(model="m", messages=messages, tools=tools)
    result["tools"][0]["function"]["parameters"]["changed"] = True
    return {
        "input_unchanged": before == json.dumps({"messages": messages, "tools": tools}, ensure_ascii=True, sort_keys=True),
        "tools_copied": "changed" not in tools[0]["function"]["parameters"],
    }


def usage_response(prompt: int, detail: int, top: int, completion: int = 0, reasoning: int = 0):
    return TRANSPORT.normalize_response({
        **response(),
        "usage": {
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "cached_tokens": top,
            "prompt_tokens_details": {"cached_tokens": detail},
            "completion_tokens_details": {"reasoning_tokens": reasoning},
        },
    }).usage


def stream_content() -> dict[str, Any]:
    callbacks: list[list[str]] = []
    raw = assemble_streamed_response(
        [
            chunk({"content": "a"}),
            chunk({"reasoning_content": "r1"}),
            chunk({"content": "b", "reasoning_content": "r2"}, "stop"),
        ],
        on_text=lambda value: callbacks.append(["text", value]),
        on_reasoning=lambda value: callbacks.append(["reasoning", value]),
    )
    return {"callbacks": callbacks, "result": primitive(TRANSPORT.normalize_response(raw))}


def stream_usage() -> Any:
    raw = assemble_streamed_response([
        {"choices": [], "usage": {"prompt_tokens": 1}},
        chunk({"content": "x"}, "stop"),
        {"choices": [], "usage": {"prompt_tokens": 9, "completion_tokens": 2}},
    ])
    return primitive(TRANSPORT.normalize_response(raw))


def stream_tools() -> Any:
    raw = assemble_streamed_response([
        chunk({"tool_calls": [{"index": 2, "function": {"arguments": '{"a":'}}]}),
        chunk({"tool_calls": [{"index": 1, "id": "c1", "function": {"name": "second", "arguments": "{}"}}]}),
        chunk({"tool_calls": [{"index": 2, "id": "c2", "function": {"name": "first", "arguments": "1}"}}]}, "tool_calls"),
    ])
    return primitive(TRANSPORT.normalize_response(raw))


def stream_incomplete() -> list[str]:
    fixtures = [
        [chunk({}, "tool_calls")],
        [chunk({"tool_calls": [{"index": 0, "function": {"name": "x"}}]}, "tool_calls")],
        [chunk({"tool_calls": [{"index": 0, "id": "c"}]}, "tool_calls")],
        [chunk({"tool_calls": [{"index": 0, "id": "c", "function": {"name": ""}}]}, "tool_calls")],
        [chunk({"tool_calls": [{"index": 0, "id": "good", "function": {"name": "ok"}}, {"index": 1, "id": "bad"}]}, "tool_calls")],
    ]
    out: list[str] = []
    for chunks in fixtures:
        try:
            assemble_streamed_response(chunks)
            out.append("NO_ERROR")
        except Exception as exc:
            out.append(str(exc))
    return out


def stream_orphan() -> dict[str, Any]:
    class Handler(logging.Handler):
        messages: list[str] = []
        def emit(self, record: logging.LogRecord) -> None:
            self.messages.append(record.getMessage())
    handler = Handler()
    logger = logging.getLogger("lohra.agent.client")
    logger.addHandler(handler)
    try:
        raw = assemble_streamed_response([
            chunk({"tool_calls": [{"index": 0, "id": "c", "function": {"name": "x"}}]}, "stop")
        ])
    finally:
        logger.removeHandler(handler)
    return {"warnings": handler.messages, "raw": raw}


def errors() -> list[str | None]:
    import httpx
    import openai
    rate = openai.RateLimitError("rate", response=httpx.Response(429, request=httpx.Request("POST", "http://x")), body=None)
    cases = [
        rate,
        type("E", (Exception,), {"status_code": 429})("x"),
        type("E", (Exception,), {"status": 429})("x"),
        type("E", (Exception,), {"code": "quota_exceeded"})("x"),
        type("E", (Exception,), {"status": "429"})("429 rate limit exceeded"),
        type("E", (Exception,), {"code": 429})("x"),
        type("E", (Exception,), {"status_code": 500})("x"),
    ]
    return [classify_provider_error(case) for case in cases]


def retry_after() -> list[float | None]:
    both = type("E", (Exception,), {"retry_after": "2.5", "response": SimpleNamespace(headers={"retry-after": "11"})})("x")
    header = type("E", (Exception,), {"response": SimpleNamespace(headers={"retry-after": "11"})})("x")
    invalid = [type("E", (Exception,), {"retry_after": value})("x") for value in [0, -1, True, "tomorrow", "Wed, 21 Oct 2015 07:28:00 GMT"]]
    return [retry_after_seconds(both), retry_after_seconds(header), *[retry_after_seconds(item) for item in invalid]]


def timeout_retry() -> dict[str, Any]:
    calls: list[dict[str, Any]] = []
    class Create:
        def create(self, **kwargs: Any):
            calls.append(kwargs)
            if len(calls) == 1:
                raise RuntimeError("timeout while sending stream_options")
            return [chunk({"content": "ok"}, "stop")]
    client = object.__new__(OpenAIClient)
    client._client = SimpleNamespace(chat=SimpleNamespace(completions=Create()))
    raw = client.stream(model="m", messages=[])
    return {"requests": calls, "result": primitive(TRANSPORT.normalize_response(raw))}


def routing() -> dict[str, Any]:
    profiles = list_providers()
    rows = []
    for profile in profiles:
        if profile.api_mode == "chat_completions":
            rows.append({"name": profile.name, "api_mode": profile.api_mode, "key": "present"})
        else:
            rows.append({"name": profile.name, "error": f"UNSUPPORTED_API_MODE:{profile.api_mode}"})
    return {"rows": rows, "alias": get_provider_profile("OR").name, "ollama": "lohra-local"}


def client_mode(kind: str) -> dict[str, Any]:
    client = OpenAIClient(api_key="lohra-local", base_url="http://localhost:11434/v1")
    kwargs = TRANSPORT.build_kwargs(model="stub-coder:1b", messages=[{"role": "user", "content": "hi"}], tools=[], max_tokens=8192)
    try:
        raw = client.stream(**kwargs) if kind == "stream" else client.create(**kwargs)
        return {"ok": True, "response": primitive(TRANSPORT.normalize_response(raw)), "classification": None}
    except Exception as exc:
        return {
            "ok": False,
            "response": None,
            "classification": classify_provider_error(exc),
            "status_code": getattr(exc, "status_code", None),
        }
    finally:
        client.close()


def run() -> Any:
    if MODE == "build-core": return build_core()
    if MODE == "build-boundaries": return build_boundaries()
    if MODE in {"build-unicode", "json-stringify-mutant"}: return build_unicode()
    if MODE == "build-copy": return build_copy()
    if MODE == "normalize-core": return primitive(TRANSPORT.normalize_response({"choices": []}))
    if MODE == "normalize-finish": return [TRANSPORT.normalize_response(response(v)).finish_reason for v in ["stop", "length", "tool_calls", "function_call", "content_filter", None, "weird", ""]]
    if MODE == "normalize-tools": return primitive(TRANSPORT.normalize_response(response("tool_calls", {"content": None, "reasoning_content": "thought", "tool_calls": [{"id": None, "function": {"name": None, "arguments": None}}]})))
    if MODE == "usage-basic": return primitive(usage_response(100, 40, 0, 20, 7))
    if MODE == "usage-fallback": return [primitive(usage_response(100, 0, 40)), primitive(usage_response(100, 10, 40))]
    if MODE == "usage-negative": return [primitive(usage_response(10, 999, 0)), primitive(usage_response(-5, 999, 0))]
    if MODE in {"stream-content-reasoning", "stream-reasoning-mutant", "stream-callbacks"}: return stream_content()
    if MODE == "stream-usage": return stream_usage()
    if MODE == "stream-tools": return stream_tools()
    if MODE == "stream-incomplete": return stream_incomplete()
    if MODE == "stream-orphan": return stream_orphan()
    if MODE == "error-classification": return errors()
    if MODE == "retry-after": return retry_after()
    if MODE == "client-timeout-prose-retry": return timeout_retry()
    if MODE == "provider-routing": return routing()
    if MODE == "client-nonstream": return client_mode("nonstream")
    if MODE == "client-stream": return client_mode("stream")
    raise ValueError(f"unknown mode: {MODE}")


emit(run())
