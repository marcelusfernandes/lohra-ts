#!/usr/bin/env python3
"""T20 oracle driver — deterministic, offline, socket-guarded observations.

Doubles live only at the sanctioned seams (DNS resolution, HTTP transport,
search backend). Parsing, limits, redirects, envelopes, registry and the chat
loop are the pinned oracle under test.
"""
from __future__ import annotations

import hashlib
import json
import re
import socket
import sys
from typing import Any

import httpx

import lohra.web.search as web_search
import lohra.web.tool as web_tool
from lohra.agent.agent import Agent
from lohra.agent.client import ModelClient
from lohra.agent.loop import run_conversation
from lohra.agent.types import NormalizedResponse, ToolCall, Usage
from lohra.providers.base import ProviderProfile
from lohra.providers.transports.base import Transport, register_transport
from lohra.tools.registry import ToolRegistry, registry

scenario = sys.argv[1]

PUBLIC = "93.184.216.34"
PUBLIC_V6 = "2606:4700:4700::1111"
CANNED_URL_ARGS = '{"url": "http://public.test/"}'
DDG_RESULT_HTML = (
    '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fone.test">One</a>'
    '<a class="result__snippet">The snippet</a>'
    '<a class="result__a" href="https://two.test">Two</a>'
)


class Dns:
    """Per-host answer sequences: the last answer repeats (rebinding opt-in)."""

    def __init__(self, table: dict[str, list[str]]):
        self.table = table
        self.calls: list[str] = []
        self.answer_cursor: dict[str, int] = {}

    def __call__(self, host: str, port: object = None) -> list:
        self.calls.append(host)
        ips = self.table.get(host)
        if ips is None:
            raise socket.gaierror("fixture DNS failed")
        if len(ips) == 0:
            return []
        index = self.answer_cursor.get(host, 0)
        self.answer_cursor[host] = min(index + 1, len(ips) - 1)
        answer = ips[index]
        return [
            (
                socket.AF_INET6 if ":" in answer else socket.AF_INET,
                socket.SOCK_STREAM,
                6,
                "",
                (answer, 0, 0, 0) if ":" in answer else (answer, 0),
            )
        ]


class World:
    """DNS double + counting MockTransport world with a parser-call counter."""

    def __init__(self, table: dict[str, list[str]]):
        self.dns = Dns(table)
        self.requests: list[str] = []
        self.request_bodies: list[str] = []
        self.authorization: list[str] = []
        self.served = 0
        self.parser_calls = 0
        self._serve = None
        self._patches: list[tuple[object, str, object]] = []

    def text(self, body: bytes, content_type: str = "text/plain", status: int = 200):
        def serve(request: httpx.Request) -> httpx.Response:
            def iterator():
                self.served += len(body)
                yield body

            return self.respond(status, iterator(), {"content-type": content_type})

        return serve

    def redirect(self, location: str, status: int = 302):
        def serve(request: httpx.Request) -> httpx.Response:
            return self.respond(status, None, {"location": location})

        return serve

    def redirect_then_body(self, location: str, content_type: str = "text/plain", status: int = 302, body: bytes = b"arrived"):
        def serve(request: httpx.Request) -> httpx.Response:
            if len(self.requests) <= 1:
                return self.redirect(location, status)(request)
            return self.text(body, content_type)(request)

        return serve

    def chain(self, redirect_count: int, body: bytes = b"arrived"):
        def serve(request: httpx.Request) -> httpx.Response:
            if len(self.requests) <= redirect_count:
                return self.respond(302, None, {"location": f"/h{len(self.requests) + 1}"})
            return self.text(body)(request)

        return serve

    def respond(self, status: int, content: Any, headers: dict) -> httpx.Response:
        response = httpx.Response(status, content=content, headers=headers)
        response.request = httpx.Request("GET", self.requests[-1] if self.requests else "http://fixture.test/")
        return response

    def httpx_client(self, **kwargs: Any) -> httpx.Client:
        kwargs["transport"] = httpx.MockTransport(self._handle)
        kwargs["trust_env"] = False
        return self._original_client(**kwargs)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(str(request.url))
        self.request_bodies.append(request.content.decode("utf-8"))
        if request.headers.get("authorization"):
            self.authorization.append("present")
        if self._serve is None:
            raise AssertionError("fixture serve missing")
        response = self._serve(request)
        response.request = request
        return response

    def counting_parser(self, html: str, max_results: int):
        self.parser_calls += 1
        return self._original_parser(html, max_results)

    def __enter__(self) -> "World":
        self._patches = [
            (socket, "getaddrinfo", socket.getaddrinfo),
            (httpx, "Client", httpx.Client),
            (web_search, "parse_ddg_html", web_search.parse_ddg_html),
        ]
        self._original_client = httpx.Client
        self._original_parser = web_search.parse_ddg_html
        socket.getaddrinfo = self.dns  # type: ignore[assignment]
        httpx.Client = self.httpx_client  # type: ignore[assignment]
        web_search.parse_ddg_html = self.counting_parser  # type: ignore[assignment]
        return self

    def __exit__(self, *_exc: object) -> None:
        for owner, name, value in reversed(self._patches):
            setattr(owner, name, value)
        self._patches = []

    @staticmethod
    def _mask_credentials(value: Any) -> Any:
        pattern = re.compile(r"(?<=://)([^/@/?#]+)@")

        def mask(entry: Any) -> Any:
            if isinstance(entry, str):
                return pattern.sub("userinfo:canary@", entry)
            if isinstance(entry, list):
                return [mask(item) for item in entry]
            if isinstance(entry, dict):
                return {key: mask(item) for key, item in entry.items()}
            return entry

        return mask(value)

    def observation(self, result: Any) -> dict:
        return {
            "result": self._mask_credentials(result),
            "dns": list(self.dns.calls),
            "requests": self._mask_credentials(list(self.requests)),
            "requestBodies": list(self.request_bodies),
            "authorization": list(self.authorization),
            "bodyBytesRead": self.served,
            "parserCalls": self.parser_calls,
        }


class UnexpectedBackend:
    def __init__(self, value: Exception):
        self.value = value

    def search(self, query: str, *, max_results: int = 5):
        raise self.value


class DownBackend:
    def __init__(self, value: Exception):
        self.value = value

    def search(self, query: str, *, max_results: int = 5):
        raise self.value


class RecordingBackend:
    def __init__(self) -> None:
        self.calls: list[tuple[Any, int]] = []

    def search(self, query: str, *, max_results: int = 5):
        self.calls.append((query, max_results))
        return [
            type("R", (), {"title": str(index), "url": f"https://{index}.test", "snippet": "s"})()
            for index in range(12)
        ][:max_results]


def tool_fetch(world: World, url: str) -> dict:
    parsed = json.loads(registry.dispatch("web_fetch", {"url": url}))
    return world.observation(parsed)


def tool_search(world: World, args: dict) -> dict:
    parsed = json.loads(registry.dispatch("web_search", args))
    return world.observation(parsed)


def text_summary(text: str) -> dict:
    return {
        "length": len(text),
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "head": text[:16],
        "tail": text[-4:],
    }


class FakeModelClient(ModelClient):
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def create(self, **kwargs: Any) -> NormalizedResponse:
        self.calls.append(kwargs)
        if len(self.calls) == 1:
            return NormalizedResponse(
                content=None,
                finish_reason="tool_calls",
                tool_calls=(ToolCall(id="c1", name="web_fetch", arguments=CANNED_URL_ARGS),),
                usage=Usage(input_tokens=3, output_tokens=2),
            )
        return NormalizedResponse(
            content="final answer", finish_reason="stop", usage=Usage(input_tokens=3, output_tokens=2)
        )


class FakeLoopTransport(Transport):
    api_mode = "fixture_chat"

    def build_kwargs(self, **kwargs: Any) -> dict:
        return dict(kwargs)

    def normalize_response(self, raw: NormalizedResponse) -> NormalizedResponse:
        return raw


def chat_canned(world: World) -> dict:
    register_transport(FakeLoopTransport())
    client = FakeModelClient()
    agent = Agent(
        model="stub-model",
        provider=ProviderProfile(name="fixture", api_mode="fixture_chat", requires_api_key=False),
        client=client,
        tool_definitions=tuple(registry.get_definitions({"web"})),
        tool_dispatch=registry.dispatch,
    )
    result = run_conversation(agent, "fetch example")
    tool_messages = [message for message in result["messages"] if message.get("role") == "tool"]
    tool_message = tool_messages[0] if tool_messages else {}
    usage_total = result["usage_total"]
    return {
        "definitions": [definition["function"]["name"] for definition in registry.get_definitions({"web"})],
        "toolCall": {"id": "c1", "name": "web_fetch", "arguments": {"url": "http://public.test/"}},
        "toolResultEnvelope": json.loads(str(tool_message.get("content", "{}"))),
        "resentToolMessage": tool_message,
        "finalResponse": result["final_response"],
        "usageTotal": {
            "input_tokens": usage_total.input_tokens,
            "output_tokens": usage_total.output_tokens,
        },
        "dns": list(world.dns.calls),
        "requests": list(world.requests),
        "bodyBytesRead": world.served,
    }


def main() -> None:
    def fatal_socket(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("socket forbidden")

    socket.socket = fatal_socket  # type: ignore[assignment]
    observation: dict = {}

    if scenario == "definitions":
        observation = {
            "definitions": [
                {
                    "name": definition["function"]["name"],
                    "description": definition["function"]["description"],
                    "parameters": definition["function"]["parameters"],
                }
                for definition in registry.get_definitions({"web"})
            ]
        }

    elif scenario == "chat-canned":
        world = World({"public.test": [PUBLIC]})
        world._serve = world.text(b"<html><body>chat body</body></html>", "text/html")
        with world:
            observation = chat_canned(world)

    elif scenario == "missing-arguments":
        rows = []
        world = World({"public.test": [PUBLIC]})
        world._serve = world.text(b"never")
        with world:
            for url in [None, "", 0, False, [], {}]:
                parsed = json.loads(registry.dispatch("web_fetch", {} if url is None else {"url": url}))
                rows.append({
                    "input": url,
                    "result": parsed,
                    "dnsCount": len(world.dns.calls),
                    "requestCount": len(world.requests),
                })
            for query in [None, "", "   ", 0, False]:
                parsed = json.loads(registry.dispatch("web_search", {} if query is None else {"query": query}))
                rows.append({
                    "input": query,
                    "result": parsed,
                    "dnsCount": len(world.dns.calls),
                    "requestCount": len(world.requests),
                })
        observation = {"rows": rows}

    elif scenario == "coercions":
        rows = []
        with World({}) as world:
            world._serve = world.text(b"never")
            original = web_tool._backend
            try:
                for maximum in [None, 0, -9, 11, "7", "bad", 2.9, True, False, []]:
                    backend = RecordingBackend()
                    web_tool.set_search_backend(backend)
                    envelope = json.loads(registry.dispatch("web_search", {"query": "q", "max_results": maximum}))
                    rows.append({
                        "input": maximum,
                        "backendQuery": backend.calls[0][0],
                        "backendMax": backend.calls[0][1],
                        "resultCount": len(envelope.get("results", [])),
                        "envelopeQuery": envelope.get("query"),
                    })
                for query in [True, 7, ["x"]]:
                    backend = RecordingBackend()
                    web_tool.set_search_backend(backend)
                    envelope = json.loads(registry.dispatch("web_search", {"query": query}))
                    rows.append({
                        "input": query,
                        "backendQuery": backend.calls[0][0],
                        "backendMax": backend.calls[0][1],
                        "envelopeQuery": envelope.get("query"),
                    })
            finally:
                web_tool.set_search_backend(original)
        observation = {"rows": rows}

    elif scenario == "scheme-host":
        rows = []
        world = World({})
        world._serve = world.text(b"never")
        with world:
            for url in ["puBlic.test/x", "file:///etc/passwd", "ftp://public.test/x", "http:///path"]:
                row = tool_fetch(world, url)
                row["input"] = url
                rows.append(row)
        observation = {"rows": rows}

    elif scenario == "port-invalid":
        world = World({"public.test": [PUBLIC]})
        world._serve = world.text(b"never")
        with world:
            observation = tool_fetch(world, "http://public.test:bad/")

    elif scenario == "userinfo":
        rows = []
        world = World({"public.test": [PUBLIC]})
        world._serve = world.text(b"accepted")
        with world:
            rows.append(tool_fetch(world, "http://alice:secret@public.test/"))
        credential_world = World({"public.test": [PUBLIC]})

        def credential_serve(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/one":
                return credential_world.redirect("http://carol:pw@public.test/final")(request)
            return credential_world.text(b"accepted")(request)

        credential_world._serve = credential_serve
        with credential_world:
            rows.append(tool_fetch(credential_world, "http://public.test/one"))
        observation = {"rows": rows}

    elif scenario == "dns-failures":
        rows = []
        world = World({})
        world._serve = world.text(b"never")
        with world:
            rows.append(tool_fetch(world, "http://missing.test/"))
        empty_world = World({"public.test": []})
        empty_world._serve = empty_world.text(b"never")
        with empty_world:
            rows.append(tool_fetch(empty_world, "http://public.test/"))
        observation = {"rows": rows}

    elif scenario == "non-public-hostname":
        rows = []
        world = World({"private.test": ["10.0.0.5"], "mixed.test": [PUBLIC, "10.0.0.5"]})
        world._serve = world.text(b"never")
        with world:
            for url in ["http://private.test/", "http://mixed.test/"]:
                rows.append(tool_fetch(world, url))
        observation = {"rows": rows}

    elif scenario == "non-public-literals":
        rows = []
        world = World({
            "2130706433": ["127.0.0.1"],
            "0x7f000001": ["127.0.0.1"],
            "127.1": ["127.0.0.1"],
            "fe80::1": ["fe80::1"],
            "::ffff:127.0.0.1": ["::ffff:127.0.0.1"],
            "10.0.0.5": ["10.0.0.5"],
        })
        world._serve = world.text(b"never")
        with world:
            for host in ["2130706433", "0x7f000001", "127.1"]:
                rows.append(tool_fetch(world, f"http://{host}/"))
            rows.append(tool_fetch(world, "http://[fe80::1]/"))
            rows.append(tool_fetch(world, "http://[::ffff:127.0.0.1]/"))
            rows.append(tool_fetch(world, "http://10.0.0.5:8080/"))
        observation = {"rows": rows}

    elif scenario == "literal-public":
        rows = []
        world = World({"93.184.216.34": [PUBLIC], "2606:4700:4700::1111": [PUBLIC_V6]})
        world._serve = world.text(b"literal ok")
        with world:
            rows.append(tool_fetch(world, "http://93.184.216.34/"))
            rows.append(tool_fetch(world, f"http://[{PUBLIC_V6}]/"))
        observation = {"rows": rows}

    elif scenario == "redirect-flow":
        rows = []
        table = {"public.test": [PUBLIC], "hop.test": [PUBLIC], "private.test": ["10.0.0.5"]}
        cases = [
            ("relative", "/b", 302),
            ("protocol-relative", "//hop.test/c", 302),
            ("https-301", "https://hop.test/d", 301),
            ("302", "http://hop.test/d", 302),
            ("303", "http://hop.test/d", 303),
            ("307", "http://hop.test/d", 307),
            ("308", "http://hop.test/d", 308),
            ("to-private", "http://private.test/", 302),
            ("to-userinfo", "http://carol:pw@public.test/", 302),
            ("no-location", None, 302),
        ]
        for name, location, status in cases:
            world = World(table)
            if location is None:
                world._serve = lambda request: world.respond(302, None, {})
            else:
                world._serve = world.redirect_then_body(location, status=status)
            with world:
                row = tool_fetch(world, "http://public.test/a")
                row["input"] = name
                rows.append(row)
        observation = {"rows": rows}

    elif scenario == "redirect-limits":
        rows = []
        for name, redirect_count in [("four-redirects", 4), ("five-redirects", 5)]:
            world = World({"public.test": [PUBLIC]})
            world._serve = world.chain(redirect_count)
            with world:
                row = tool_fetch(world, "http://public.test/start")
                row["input"] = name
                rows.append(row)
        world = World({"public.test": [PUBLIC]})
        world._serve = lambda request: world.respond(302, None, {})
        with world:
            row = tool_fetch(world, "http://public.test/start")
            row["input"] = "no-location"
            rows.append(row)
        observation = {"rows": rows}

    elif scenario == "fetch-bounds":
        rows = []
        big = bytes(1_500_000)
        bodies = [
            b"x" * 1_999_999,
            b"x" * 2_000_000,
            b"x" * 2_000_001,
            big + big,
            b"x" * (2_000_000 - 1) + b"\xe4\xb8\x80",
        ]
        for index, body in enumerate(bodies):
            world = World({"public.test": [PUBLIC]})
            world._serve = world.text(body)
            with world:
                parsed = json.loads(registry.dispatch("web_fetch", {"url": "http://public.test/"}))
                text = parsed.get("text", "")
                rows.append({
                    "input": index,
                    "text": text_summary(text),
                    "error": parsed.get("error"),
                    "dnsCount": len(world.dns.calls),
                    "requestCount": len(world.requests),
                    "bodyBytesRead": world.served,
                })
        observation = {"rows": rows}

    elif scenario == "content-types":
        rows = []
        for content_type in [
            "",
            "text/plain",
            "text/html; charset=utf-8",
            "application/json",
            "application/xml",
            "application/javascript",
            "text/csv",
            "image/svg+xml",
            "application/jsonp",
            "x-anything/htmlish",
            "image/png",
            "application/octet-stream",
        ]:
            world = World({"public.test": [PUBLIC]})
            world._serve = world.text(b"body", content_type)
            with world:
                row = tool_fetch(world, "http://public.test/")
                row["input"] = content_type if content_type else "missing"
                rows.append(row)
        world = World({"public.test": [PUBLIC]})
        world._serve = world.text(b"err text", "text/plain", status=500)
        with world:
            row = tool_fetch(world, "http://public.test/")
            row["input"] = "status-500"
            rows.append(row)
        observation = {"rows": rows}

    elif scenario == "encoding":
        rows = []
        world = World({"public.test": [PUBLIC]})
        world._serve = world.text(bytes([0xFF, 0xFE]), "text/plain; charset=iso-8859-1")
        with world:
            rows.append(tool_fetch(world, "http://public.test/"))
        world = World({"public.test": [PUBLIC]})
        world._serve = world.text(b"abc\xff")
        with world:
            rows.append(tool_fetch(world, "http://public.test/"))
        observation = {"rows": rows}

    elif scenario == "peer-matrix":
        rows = []
        rebind_world = World({"rebind.test": [PUBLIC]})
        rebind_world._serve = rebind_world.text(b"SIMULATED_PRIVATE_BODY")
        with rebind_world:
            row = tool_fetch(rebind_world, "http://rebind.test/")
            row["input"] = "direct"
            rows.append(row)
        hop_world = World({"start.test": [PUBLIC], "hop.test": [PUBLIC]})

        def rebind_after_redirect(request: httpx.Request) -> httpx.Response:
            if request.url.host == "start.test":
                return hop_world.redirect("http://hop.test/")(request)
            return hop_world.text(b"SIMULATED_REDIRECT_PRIVATE_BODY")(request)

        hop_world._serve = rebind_after_redirect
        with hop_world:
            row = tool_fetch(hop_world, "http://start.test/")
            row["input"] = "after-redirect"
            rows.append(row)
        observation = {"rows": rows}

    elif scenario == "search-unavailable":
        rows = []

        def connect_failed(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("fixture connect failed", request=request)

        ddg_world = World({"html.duckduckgo.com": [PUBLIC]})
        ddg_world._serve = ddg_world.text(b"moved", "text/html", status=302)
        with ddg_world:
            rows.append(tool_search(ddg_world, {"query": "q"}))
        transport_world = World({"html.duckduckgo.com": [PUBLIC]})
        transport_world._serve = connect_failed
        with transport_world:
            rows.append(tool_search(transport_world, {"query": "q"}))
        with World({}) as world:
            world._serve = world.text(b"never")
            original = web_tool._backend
            try:
                web_tool.set_search_backend(DownBackend(web_search.SearchUnavailable("fixture down")))
                rows.append(tool_search(world, {"query": "q"}))
                web_tool.set_search_backend(DownBackend(web_search.WebError("fixture web error")))
                rows.append(tool_search(world, {"query": "q"}))
            finally:
                web_tool.set_search_backend(original)
        observation = {"rows": rows}

    elif scenario == "ddg-flow":
        world = World({"html.duckduckgo.com": [PUBLIC]})
        world._serve = world.text(DDG_RESULT_HTML.encode("utf-8"), "text/html")
        with world:
            observation = tool_search(world, {"query": "fixture query", "max_results": 5})

    elif scenario == "ddg-empty-and-clamp":
        rows = []
        many = "".join(
            f'<a class="result__a" href="https://{index}.test">t</a>' for index in range(12)
        )
        for name, html, maximum in [
            ("empty", "<p>no anchors</p>", 5),
            ("clamp-10", many, 5),
            ("clamp-3", many, 3),
        ]:
            world = World({"html.duckduckgo.com": [PUBLIC]})
            world._serve = world.text(html.encode("utf-8"), "text/html")
            with world:
                row = tool_search(world, {"query": "q", "max_results": maximum})
                row["input"] = name
                rows.append(row)
        observation = {"rows": rows}

    elif scenario == "ddg-byte-cap":
        rows = []
        for size in [1_999_999, 2_000_000, 2_000_001]:
            world = World({"html.duckduckgo.com": [PUBLIC]})

            def serve(request: httpx.Request, size: int = size, world: World = world) -> httpx.Response:
                def iterator():
                    remaining = size
                    while remaining > 0:
                        piece = b"z" * min(remaining, 100_000)
                        remaining -= len(piece)
                        world.served += len(piece)
                        yield piece

                return world.respond(200, iterator(), {"content-type": "text/html"})

            world._serve = serve
            with world:
                row = tool_search(world, {"query": "q", "max_results": 5})
                row["input"] = size
                rows.append(row)
        observation = {"rows": rows}

    elif scenario == "transport-failures":
        rows = []

        def connect_failed(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("fixture connect failed", request=request)

        def tls_failed(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("fixture TLS verification failed", request=request)

        def timeout(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectTimeout("fixture timeout after 10 seconds", request=request)

        stream_world = World({"public.test": [PUBLIC]})

        def stream_aborted(request: httpx.Request) -> httpx.Response:
            def iterator():
                stream_world.served += 7
                yield b"partial"
                raise httpx.ReadError("fixture stream aborted")

            return stream_world.respond(200, iterator(), {"content-type": "text/plain"})

        stream_world._serve = stream_aborted
        for world, name in [
            (World({"public.test": [PUBLIC]}), "connect"),
            (World({"public.test": [PUBLIC]}), "tls"),
            (World({"public.test": [PUBLIC]}), "timeout"),
            (stream_world, "stream"),
        ]:
            if name == "connect":
                world._serve = connect_failed
            elif name == "tls":
                world._serve = tls_failed
            elif name == "timeout":
                world._serve = timeout
            with world:
                row = tool_fetch(world, "http://public.test/")
                row["input"] = name
                rows.append(row)
        observation = {"rows": rows}

    elif scenario == "registry-boundary":
        target = ToolRegistry()

        def boom(_args: dict, **_kwargs: object) -> str:
            raise RuntimeError("fixture unexpected")

        target.register("boom", "x", {"description": "d", "parameters": {}}, boom)
        rows = [
            {"dispatch": json.loads(target.dispatch("boom", {}))},
            {"unknown": json.loads(target.dispatch("missing", {}))},
        ]
        with World({}) as world:
            world._serve = world.text(b"never")
            original = web_tool._backend
            try:
                web_tool.set_search_backend(UnexpectedBackend(TypeError("fixture unexpected")))

                def fetch_serve(request: httpx.Request) -> httpx.Response:
                    raise TypeError("fixture unexpected")

                world._serve = fetch_serve
                rows.append({"search": tool_search(world, {"query": "q"})})
                rows.append({"fetch": tool_fetch(world, "http://public.test/")})
            finally:
                web_tool.set_search_backend(original)
        observation = {"rows": rows}

    elif scenario == "peer-divergent":
        world = World({"divergent.test": [PUBLIC]})
        world._serve = world.text(b"SIMULATED_DIVERGENT_BODY")
        with world:
            observation = tool_fetch(world, "http://divergent.test/")

    elif scenario == "rebinding":
        world = World({"once.test": [PUBLIC, "10.0.0.5"]})
        world._serve = world.text(b"rebinding ok")
        with world:
            observation = tool_fetch(world, "http://once.test/")

    elif scenario == "connector-tls":
        import ssl

        client = httpx.Client()
        try:
            pool = client._transport._pool  # noqa: SLF001 — the oracle stack observed
            verify_mode = pool._ssl_context.verify_mode  # noqa: SLF001
            observation = {"tlsVerificationEnforced": verify_mode == ssl.CERT_REQUIRED}
        finally:
            client.close()

    else:
        raise SystemExit(f"unknown scenario {scenario}")

    print(json.dumps(observation, sort_keys=True))


if __name__ == "__main__":
    raise SystemExit(main())
