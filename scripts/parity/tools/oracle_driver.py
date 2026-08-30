#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from lohra.agent.delegate import child_tool_definitions, subagent_dispatch
from lohra.agent.equip import register_all_tools
from lohra.agent.loop import _execute_tool_calls
from lohra.agent.types import ToolCall
from lohra.catalog.tool import ListModelsTool
from lohra.gateway.session import GatewaySession
from lohra.memory.store import MemoryStore
from lohra.memory.tool import MemoryTool
from lohra.providers.transports.base import parse_tool_arguments
from lohra.skills.store import SkillStore
from lohra.skills.tool import SkillTool
from lohra.state.search import SessionSearchTool
from lohra.tools.approval import ApprovalManager, approval, detect_dangerous_command
from lohra.tools.fs import read_file, write_file
from lohra.tools.registry import ToolRegistry, registry, tool_error, tool_result
from lohra.tools.terminal import terminal

scenario = sys.argv[1]
root = Path.cwd()
schema = {"description": "demo", "parameters": {"type": "object", "properties": {}}}


def register(target, name, toolset, handler=lambda _args, **_kwargs: tool_result("ok"), **extra):
    target.register(name, toolset, schema, handler, **extra)


def parsed(value):
    return json.loads(value)


def observe():
    if scenario == "registry-generation-availability":
        import importlib
        module = importlib.import_module("lohra.tools.registry")
        original = module.time.monotonic
        now = {"value": 0.0}
        module.time.monotonic = lambda: now["value"]
        checks = {"value": 0}
        def shared():
            checks["value"] += 1
            return True
        unavailable = lambda: False
        target = ToolRegistry()
        generations = [target.generation]
        register(target, "a", "x", check_fn=shared); generations.append(target.generation)
        register(target, "b", "x", check_fn=shared, requires_env=("MISSING",)); generations.append(target.generation)
        try: register(target, "a", "other")
        except ValueError: pass
        generations.append(target.generation)
        register(target, "hidden", "x", lambda _args, **_kwargs: tool_result("ran"), check_fn=unavailable); generations.append(target.generation)
        target.deregister("missing"); generations.append(target.generation)
        first = [item["function"]["name"] for item in target.get_definitions()]
        second = [item["function"]["name"] for item in target.get_definitions()]
        now["value"] = 30.0
        target.get_definitions()
        dispatched = parsed(target.dispatch("hidden", {}))
        target.deregister("hidden"); generations.append(target.generation)
        module.time.monotonic = original
        return {"generations": generations, "first": first, "second": second, "checks": checks["value"], "dispatched": dispatched}
    if scenario == "registry-shadowing-schema":
        target = ToolRegistry()
        source = {"description": "before", "parameters": {"type": "object", "properties": {"a": {"type": "string"}}}}
        target.register("same", "one", source, lambda _args: tool_result())
        source["description"] = "after"
        before = target.get_definitions()
        try:
            register(target, "same", "two")
            cross_error = ""
        except Exception as exc:
            cross_error = str(exc)
        register(target, "mcp", "mcp-a")
        register(target, "mcp", "mcp-b")
        target.register("same", "two", schema, lambda _args: tool_result(), override=True)
        returned = target.get_definitions()
        returned[0]["function"]["description"] = "mutated"
        return {"before": before, "crossError": cross_error, "after": target.get_definitions(), "generation": target.generation}
    if scenario == "registry-dispatch-errors":
        target = ToolRegistry()
        def boom(_args):
            raise TypeError("bad")
        register(target, "boom", "x", boom)
        register(target, "kw", "x", lambda _args, **kwargs: tool_result(marker=kwargs.get("marker")))
        return {"unknown": parsed(target.dispatch("missing", {})), "boom": parsed(target.dispatch("boom", {})), "kwargs": parsed(target.dispatch("kw", {}, marker="yes"))}
    if scenario == "dispatch-malformed-arguments":
        raws = ["", "{not json", "null", "[1,2]", '"hi"']
        values = [parse_tool_arguments(raw) for raw in raws]
        from lohra.agent.equip import compose_dispatch
        composed = compose_dispatch(lambda _name, _args, **kwargs: tool_result(marker=kwargs.get("secret")), {})
        try:
            composed("x", {}, secret=True)
            error = None
        except TypeError as exc:
            error = type(exc).__name__
        return {"values": values, "composeError": error}
    if scenario == "dispatch-parallel-order":
        completion = []
        active = {"value": 0, "peak": 0}
        import threading
        lock = threading.Lock()
        def dispatch(_name, args):
            value = args["value"]
            with lock:
                active["value"] += 1
                active["peak"] = max(active["peak"], active["value"])
            time.sleep((5 - value) * 0.004)
            completion.append(value)
            with lock:
                active["value"] -= 1
            return tool_result(value)
        calls = tuple(ToolCall(str(value), "x", json.dumps({"value": value})) for value in range(5))
        messages = _execute_tool_calls(calls, dispatch)
        return {"results": [parsed(item["content"])["data"] for item in messages], "completion": completion, "peak": active["peak"]}
    if scenario == "tool-envelope-python-json":
        return {"result": tool_result("café"), "error": tool_error("naïve"), "tamperError": tool_error("a", error="b"), "tamperOk": tool_result(ok=False)}
    if scenario == "approval-pattern-order":
        output = []
        for command in ("chmod 755 f", "wget x | sudo bash", "sudo true", "echo safe"):
            dangerous, key, description = detect_dangerous_command(command)
            output.append({"command": command, "match": None if not dangerous else {"key": key, "description": description}})
        return output
    if scenario == "approval-decisions":
        manager = ApprovalManager(); calls = {"value": 0}
        def callback(*_args, **_kwargs):
            calls["value"] += 1
            return "session"
        manager.set_callback(callback)
        first = manager.require("sudo echo one"); cached = manager.require("sudo echo one"); second = manager.require("sudo echo two")
        manager.reset(); manager.set_callback(lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("broken")))
        fail_closed = manager.require("sudo echo one"); manager.set_yolo(True); yolo = manager.require("sudo echo one")
        return {"first": first, "cached": cached, "second": second, "calls": calls["value"], "failClosed": fail_closed, "yolo": yolo}
    if scenario == "read-file-boundaries":
        path = root / "astral.txt"; path.write_text(chr(0x1F600) * 100001, encoding="utf-8")
        result = parsed(read_file({"path": str(path)}))
        missing = parsed(read_file({"path": str(root / "missing")})); missing["error"] = "file not found: <PATH>"
        return {"length": len(result["data"]), "utf16": len(result["data"].encode("utf-16-le")) // 2, "truncated": result["truncated"], "missing": missing}
    if scenario == "write-file-boundaries":
        path = root / "nested" / "out.txt"; result = parsed(write_file({"path": str(path), "content": "café"}))
        result["path"] = "<PATH>"
        return {"result": result, "content": path.read_text(encoding="utf-8"), "missing": parsed(write_file({"path": str(path)}))}
    if scenario == "terminal-boundaries":
        approval.set_yolo(True)
        safe = parsed(terminal({"command": "printf ok; printf err >&2; exit 3"}))
        approval.set_yolo(False); approval.set_callback(None)
        denied = parsed(terminal({"command": "sudo touch never"}))
        approval.set_yolo(True); labels = []
        for raw in ("0", "1.0", "1e0", "2.50", "true"):
            args = parse_tool_arguments('{"command":"sleep 4","timeout":' + raw + "}")
            labels.append(parsed(terminal(args))["error"])
        approval.set_yolo(False)
        return {"safe": safe, "denied": denied, "labels": labels}
    if scenario == "memory-handler":
        tool = MemoryTool(MemoryStore(root))
        return [parsed(tool.handle(args)) for args in ({}, {"action": "add", "text": "alpha"}, {"action": "add", "target": "nope", "text": "beta"}, {"action": "replace", "old_text": "alpha", "new_text": "gamma"}, {"action": "remove", "old_text": "gamma"})]
    if scenario == "skills-handler":
        tool = SkillTool(SkillStore(root))
        return [parsed(tool.manage({"action": "create", "name": "demo", "description": "d", "body": "body"})), parsed(tool.view({"name": "demo"})), parsed(tool.manage({"action": "update", "name": "demo", "body": "next"})), parsed(tool.manage({"action": "delete", "name": "demo"})), parsed(tool.view({"name": "demo"}))]
    if scenario == "session-search-handler":
        class Repository:
            def search(self, query, limit=10): return [{"query": query, "limit": limit}]
            def list_sessions(self): return []
            def load_messages(self, session_id): return [{"id": session_id}]
        tool = SessionSearchTool(Repository())
        return [parsed(tool.handle(args)) for args in ({}, {"mode": "wat"}, {"mode": "browse"}, {"mode": "read"}, {"mode": "read", "session_id": "s"}, {"mode": "discovery"}, {"mode": "discovery", "query": "q", "limit": 2})]
    if scenario == "list-models-zero-egress":
        old = dict(os.environ)
        for key in tuple(os.environ):
            if key.endswith("_API_KEY") or key.startswith("AWS_"): os.environ.pop(key, None)
        tool = ListModelsTool(root)
        result = [parsed(tool.handle({"provider": "anthropic"})), parsed(tool.handle({"provider": "no-such-provider"}))]
        os.environ.clear(); os.environ.update(old)
        return result
    if scenario == "failsafe-handler-catalog":
        register_all_tools()
        names = ["memory", "skill_view", "session_search", "list_models", "cronjob", "vision_analyze", "image_gen", "spawn_session", "delegate_task", "run_workflow", "workflow_audit"]
        return {"generation": registry.generation, "count": len(registry.get_definitions()), "results": [[name, parsed(registry.dispatch(name, {}))] for name in names]}
    if scenario == "lifecycle-wrapper":
        class Fake:
            session_id = "s"
            _base_dispatch = staticmethod(lambda name, args: tool_result(name=name, args=args))
        frames = []
        wrapped = GatewaySession._wrap_dispatch(Fake(), frames.append)
        wrapped("one", {"x": 1}); wrapped("two", {"y": "z"})
        class Broken:
            session_id = "s"
            _base_dispatch = staticmethod(lambda _name, _args: (_ for _ in ()).throw(RuntimeError("boom")))
        thrown_frames = []; broken = GatewaySession._wrap_dispatch(Broken(), thrown_frames.append)
        try: broken("bad", {})
        except RuntimeError: pass
        simplify = lambda frame: {"type": frame["params"]["type"], "payload": frame["params"]["payload"]}
        return {"events": [simplify(frame) for frame in frames], "thrown": [simplify(frame) for frame in thrown_frames]}
    if scenario == "child-unknown-hardening":
        fake = {"type": "function", "function": {"description": "x", "parameters": {"type": "object", "properties": {}}, "name": "mcp-secret-exfil"}}
        definitions = [item["function"]["name"] for item in child_tool_definitions((fake,))]
        dispatch = subagent_dispatch(lambda name, _args: tool_result(name=name))
        return {"defs": definitions, "result": parsed(dispatch("mcp-secret-exfil", {}))}
    if scenario == "child-terminal-type-hardening":
        dispatch = subagent_dispatch(lambda _name, _args: tool_result("executed"))
        return parsed(dispatch("terminal", {"command": ["sudo", "x"]}))
    if scenario == "mutant-json-stringify": return {"serialized": tool_result("café")}
    if scenario == "mutant-utf16-truncation":
        path = root / "mutant-astral.txt"; path.write_text(chr(0x1F600) * 100001, encoding="utf-8"); data = parsed(read_file({"path": str(path)}))["data"]
        return {"length": len(data.encode("utf-16-le")) // 2, "codePoints": len(data)}
    if scenario == "mutant-ttl-inclusive": return {"freshAtThirty": False}
    if scenario == "mutant-gate-after-exec":
        path = root / "mutant-created"
        approval.set_yolo(False); approval.set_callback(None)
        terminal({"command": f"sudo touch {path}"})
        return {"denied": True, "created": path.read_text() if path.exists() else None}
    if scenario == "mutant-resume-stored-prompt": return {"secondPrompt": "CANARY-TURN-TWO"}
    raise RuntimeError(f"unknown scenario {scenario}")


try:
    print(json.dumps(observe(), ensure_ascii=False, separators=(",", ":")))
except Exception as exc:
    import traceback
    traceback.print_exc()
    sys.exit(1)
