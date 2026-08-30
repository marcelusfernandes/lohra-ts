#!/usr/bin/env python3
from __future__ import annotations

import datetime
import json
import os
import stat
import sys
import contextlib
import io
from pathlib import Path
from types import SimpleNamespace

from lohra.agent.system_prompt import build_system_prompt
from lohra.config.env_file import apply_env_file
from lohra.memory.soul import load_soul
from lohra.memory.store import MemoryFile, MemoryStore, _parse, _render
from lohra.onboarding import env_write, wizard
from lohra.project.discover import (
    discover_instructions,
    find_project_root,
    load_project_context,
)
from lohra.skills.store import SkillStore, render_skill_md
from lohra.cli import build_parser, main as cli_main, run_profile

home = Path(os.environ["LOHRA_HOME"])
sandbox = Path(os.environ["HOME"]) / "project"
sandbox.mkdir(parents=True, exist_ok=True)


def emit(value):
    print(json.dumps(value, ensure_ascii=True, sort_keys=True))


def mode(path: Path) -> str:
    return f"{stat.S_IMODE(path.stat().st_mode):04o}"


def error_text(function):
    try:
        function()
        return None
    except Exception as exc:  # evidence intentionally captures the public message
        return str(exc)


def write_skill(root: Path, name: str, description: str, body="body", version="1.0.0"):
    path = root / name / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_skill_md(name, description, body, version), encoding="utf-8")
    return path


def snapshot(**overrides):
    provider_names = ["anthropic", "openai", "ollama"]
    values = dict(
        active_profile=None,
        auth_preference="auto",
        auth_route="api_key",
        detected_provider=None,
        env_file=str(home / ".env"),
        env_file_present=False,
        harnesses=(),
        home=str(home),
        interactive=True,
        stdin_tty=True,
        stderr_tty=True,
        ollama=SimpleNamespace(alive=False, models=(), url="http://localhost:11434/api/tags"),
        provider_error=None,
        provider_origin="none",
        providers=tuple(
            SimpleNamespace(provider=name, present_vars=(), installed=False, home_present=False)
            for name in provider_names
        ),
        python_supported=True,
        python_version="3.12.10",
        subscription_active=False,
    )
    values.update(overrides)
    return SimpleNamespace(**values)


def memory_core(mutant=False):
    path = home / "memories" / "MEMORY.md"
    file = MemoryFile(path, 2200)
    astral = "😀" * 1101
    boundary = error_text(
        lambda: MemoryFile(home / "memories" / "ASTRAL.md", 2200).add(astral)
    ) is None
    file.add("alpha")
    file.add("alpha")
    file.add("beta one")
    file.add("beta two")
    ambiguous = error_text(lambda: file.replace("beta", "x"))
    missing = error_text(lambda: file.remove("missing"))
    before = path.read_text(encoding="utf-8")
    over = error_text(lambda: MemoryFile(path, 2200).add("x" * 2201))
    emit(
        {
            "parse": [_parse("one§two"), _parse("cost is 50§ per unit"), _parse(" § ")],
            "rendered": _render(["one", "two"]),
            "boundary": boundary,
            "ambiguous": ambiguous,
            "missing": missing,
            "over": over,
            "unchanged": path.read_text(encoding="utf-8") == before,
        }
    )


def memory_discipline():
    path = home / "memories" / "MEMORY.md"
    previous = os.umask(0)
    try:
        MemoryFile(path, 2200).add("integral")
    finally:
        os.umask(previous)
    emit(
        {
            "content": path.read_text(encoding="utf-8"),
            "mode": mode(path),
            "temps": sorted(p.name for p in path.parent.iterdir() if p.name.endswith(".tmp")),
        }
    )


def snapshot_freeze():
    store = MemoryStore(home)
    store.memory.add("first")
    store.user.add("user-one")
    store.load_snapshot()
    first = dict(store.snapshot())
    store.memory.add("second")
    frozen = dict(store.snapshot())
    fresh = MemoryStore(home)
    fresh.load_snapshot()
    emit({"first": first, "frozen": frozen, "fresh": dict(fresh.snapshot())})


def prompt_snapshot():
    value = build_system_prompt(
        identity="SOUL",
        environment_hints={"project_root": "/project", "cwd": "/project/sub"},
        system_message=" system ",
        context_files=(("AGENTS.md", "rules"),),
        memory_snapshot="memory",
        user_profile="user",
        skills_index="skills",
        today=datetime.date(2030, 1, 2),
    )
    emit({"stable": value.stable, "context": value.context, "volatile": value.volatile, "text": value.text})


def soul():
    values = [load_soul(home)]
    (home / "SOUL.md").write_text("  persona  \n", encoding="utf-8")
    values.append(load_soul(home))
    (home / "SOUL.md").write_text("   ", encoding="utf-8")
    values.append(load_soul(home))
    other = home / "other"
    (other / "SOUL.md").mkdir(parents=True)
    emit({"values": values, "directoryError": error_text(lambda: load_soul(other)) is not None})


def project_discovery():
    root = sandbox / "repo"
    leaf = root / "pkg" / "sub"
    (root / ".git").mkdir(parents=True)
    leaf.mkdir(parents=True)
    (root / "AGENTS.md").write_text("outer agents", encoding="utf-8")
    (root / "CLAUDE.md").write_text("outer claude", encoding="utf-8")
    (root / "pkg" / "AGENTS.md").write_text("near agents", encoding="utf-8")
    (root / "pkg" / "pyproject.toml").write_text("", encoding="utf-8")
    files, hints = load_project_context(leaf)
    emit({"root": str(find_project_root(leaf)), "instructions": discover_instructions(leaf), "context": {"instructions": files, "hints": hints}})


def project_bounds():
    root = sandbox / "bounds"
    leaf = root
    (root / ".git").mkdir(parents=True)
    for index in range(40):
        leaf /= f"d{index:02d}"
    leaf.mkdir(parents=True)
    far = find_project_root(leaf)
    near_root = sandbox / "near"
    near = near_root / "one" / "two"
    (near_root / ".git").mkdir(parents=True)
    near.mkdir(parents=True)
    nonexistent = sandbox / "missing" / "child"
    files, hints = load_project_context(nonexistent)
    long_path = Path("/" + "x" * 5000)
    caught_files, caught_hints = load_project_context(long_path)
    emit(
        {
            "farIsLeaf": far == leaf.resolve(),
            "nearFound": find_project_root(near) == near_root.resolve(),
            "nonexistent": {
                "instructions": files,
                "keys": sorted(hints),
                "cwdResolved": hints.get("cwd") == hints.get("project_root"),
            },
            "caught": {
                "instructions": caught_files,
                "keys": sorted(caught_hints),
                "received": caught_hints.get("cwd") == str(long_path),
            },
        }
    )


def instructions_unsafe():
    root = sandbox / "unsafe"
    (root / ".git").mkdir(parents=True)
    (root / "sub").mkdir(parents=True)
    (root / "target").write_text("SECRET", encoding="utf-8")
    (root / "sub" / "AGENTS.md").symlink_to(root / "target")
    (root / "sub" / "CLAUDE.md").mkdir()
    emit({"instructions": discover_instructions(root / "sub")})


def skills_index_edge():
    project = sandbox / "project-skills"
    builtin = sandbox / "builtin-skills"
    write_skill(project, "shared-name", "project wins")
    write_skill(home / "skills", "shared-name", "home loses")
    write_skill(home / "skills", "home-only", "home desc")
    write_skill(builtin, "b-skill", "builtin desc")
    store = SkillStore(home, (project,), (builtin,))
    index = store.index()
    oversized_path = project / "oversized" / "SKILL.md"
    oversized_path.parent.mkdir(parents=True, exist_ok=True)
    header = "---\nname: oversized\ndescription: x\nv: 1000\n---\n"
    oversized_path.write_text(header + "x" * (257047 - len(header.encode())), encoding="utf-8")
    skill = store.get("oversized")
    emit({"index": index, "oversized": {"indexed": skill is not None, "bodyLength": len(skill.body) if skill else 0, "marker": "truncated" in skill.body if skill else False}})


def skills_mutations():
    project = sandbox / "project-skills"
    builtin = sandbox / "builtin-skills"
    project.mkdir(parents=True)
    builtin_path = write_skill(builtin, "builtin-skill", "builtin", "original")
    store = SkillStore(home, (project,), (builtin,))
    created = store.create("project-new", "created", "body", "1.0.0", "project")
    updated = store.update("builtin-skill", body="edited")
    builtin_unchanged = "original" in builtin_path.read_text(encoding="utf-8")
    deleted = store.delete("builtin-skill")
    emit({"created": created.body, "updated": updated.body, "builtinUnchanged": builtin_unchanged, "deleted": deleted, "winner": store.get("builtin-skill").body})


def skills_validation():
    store = SkillStore(home)
    valid = "a" * 64
    store.create(valid, "ok", "body")
    emit(
        {
            "valid": store.get(valid).name,
            "invalid65": error_text(lambda: store.create("a" * 65, "x", "x")),
            "invalidName": error_text(lambda: store.create("Bad_Name!", "x", "x")),
            "longDescription": error_text(lambda: store.create("desc", "x" * 1025, "x")),
            "duplicate": error_text(lambda: store.create(valid, "ok", "body")),
            "projectMissing": error_text(lambda: store.create("p", "x", "x", "1.0.0", "project")),
        }
    )


def env_upsert():
    path = home / ".env"
    path.write_text("# keep\nA=old\nOTHER=x\nexport A=last\n", encoding="utf-8")
    stages = []
    original_chmod = env_write._chmod_600
    original_replace = env_write.os.replace
    original_fsync = env_write.os.fsync
    original_write_text = Path.write_text
    fsync_calls = [0]

    def observed_write_text(target, body, encoding="utf-8", **_kwargs):
        written = original_write_text(target, body, encoding=encoding)
        stages.append(["create", mode(Path(target))])
        stages.append(["write-close", mode(Path(target))])
        return written

    def observed_chmod(file):
        original_chmod(file)
        stages.append(["chmod", mode(Path(file))])

    def observed_replace(source, destination):
        original_replace(source, destination)
        stages.append(["replace", mode(Path(destination))])

    def observed_fsync(descriptor):
        fsync_calls[0] += 1
        return original_fsync(descriptor)

    previous = os.umask(0)
    try:
        env_write._chmod_600 = observed_chmod
        env_write.os.replace = observed_replace
        env_write.os.fsync = observed_fsync
        Path.write_text = observed_write_text
        changed = env_write.upsert_env_file(path, {"A": "two words", "B": "line\nbreak"})
    finally:
        env_write._chmod_600 = original_chmod
        env_write.os.replace = original_replace
        env_write.os.fsync = original_fsync
        Path.write_text = original_write_text
        os.umask(previous)
    content = path.read_text(encoding="utf-8")
    second = env_write.upsert_env_file(path, {"A": "two words", "B": "line"})
    emit({"changed": changed, "content": content, "second": second, "formats": [env_write.format_value("plain"), env_write.format_value("a b"), env_write.format_value('a"b'), env_write.format_value("a'\"b")], "mode": mode(path), "stages": stages, "fsyncCalls": fsync_calls[0]})


def env_same_key():
    path = home / ".env"
    path.write_text("SHARED=file\nONLY_FILE=yes\n", encoding="utf-8")
    environment = {"SHARED": ""}
    apply_env_file(path, environ=environment)
    written = env_write.upsert_env_file(path, {"SHARED": "writer"})
    emit({"environment": environment, "written": written, "file": path.read_text(encoding="utf-8")})


def wizard_gates():
    base = snapshot()
    rows = []
    for value in (None, "", "   ", "0", "1"):
        environment = {} if value is None else {"LOHRA_NO_WIZARD": value}
        rows.append({"value": value, "offered": wizard.should_offer_wizard(env=environment, stdin=SimpleNamespace(isatty=lambda: True), stderr=SimpleNamespace(isatty=lambda: True), home=home)})
    rows.append({"value": "json", "offered": wizard.should_offer_wizard(json_output=True, env={}, stdin=SimpleNamespace(isatty=lambda: True), stderr=SimpleNamespace(isatty=lambda: True), home=home)})
    rows.append({"value": "pipe", "offered": wizard.should_offer_wizard(env={}, stdin=SimpleNamespace(isatty=lambda: False), stderr=SimpleNamespace(isatty=lambda: True), home=home)})
    # Known configured provider: the resolver observes the environment directly.
    rows.append({"value": "configured", "offered": wizard.should_offer_wizard(env={"ANTHROPIC_API_KEY": "dummy"}, stdin=SimpleNamespace(isatty=lambda: True), stderr=SimpleNamespace(isatty=lambda: True), home=home)})
    emit(rows)


class Reader:
    def __init__(self, values, raise_on_eof=False):
        self.values = list(values)
        self.raise_on_eof = raise_on_eof

    def readline(self):
        if self.values:
            return self.values.pop(0) + "\n"
        if self.raise_on_eof:
            raise EOFError()
        return ""


class Writer:
    def __init__(self):
        self.value = ""

    def write(self, value):
        self.value += value

    def flush(self):
        pass


def wizard_configure(eof=False):
    answers = ["anthropic"] if eof else ["anthropic", "DUMMY-T06-KEY", "n"]
    prompt_writer = Writer()
    output = Writer()
    environment = {}
    harness = SimpleNamespace(name="claude", home=str(home / "claude"), installed=True, home_present=False)
    snap = snapshot(harnesses=(harness,))
    wizard.run_init(
        snapshot=snap,
        base=home,
        home=home,
        environ=environment,
        no_input=False,
        reader=Reader(answers, raise_on_eof=eof),
        out=output,
        err=prompt_writer,
    )
    env_text = (home / ".env").read_text(encoding="utf-8")
    emit({"prompts": prompt_writer.value, "output": output.value, "envKeys": [line.split("=", 1)[0] for line in env_text.strip().splitlines()], "provider": environment.get("LOHRA_PROVIDER"), "keySet": bool(environment.get("ANTHROPIC_API_KEY")), "marker": (home / ".initialized").read_text(encoding="utf-8"), "ready": wizard.evaluate(snap, environment)[0]})


def profile_call(name):
    out = io.StringIO()
    err = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = run_profile("create", name=name)
    return {"code": code, "stdout": out.getvalue(), "stderr": err.getvalue()}


def profile_errors():
    emit({"missing": profile_call(None), "invalid": profile_call("../evil")})


def profile_isolation():
    roots = {"default": home, "p1": home / "profiles" / "p1", "p2": home / "profiles" / "p2"}
    for name, root in roots.items():
        MemoryStore(root).memory.add(f"memory-{name}")
        SkillStore(root).create(f"skill-{name}", name, f"body-{name}")
        (root / "SOUL.md").write_text(f"soul-{name}", encoding="utf-8")
        wizard.write_marker(root)
    old = os.environ.get("LOHRA_PROFILE")
    os.environ["LOHRA_PROFILE"] = "p1"
    out = io.StringIO()
    err = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = run_profile("list")
    if old is None:
        os.environ.pop("LOHRA_PROFILE", None)
    else:
        os.environ["LOHRA_PROFILE"] = old
    values = {name: {"memory": MemoryStore(root).memory.render(), "skills": [skill.name for skill in SkillStore(root).scan()], "soul": load_soul(root), "marker": wizard.marker_present(root)} for name, root in roots.items()}
    emit({"listed": {"code": code, "stdout": out.getvalue(), "stderr": err.getvalue()}, "values": values})


def scope_shrink():
    # Raw-only oracle characterization: the candidate's temporary refusal list is
    # intentionally side-specific until each later ticket implements its surface.
    parser = build_parser()
    help_text = parser.format_help()
    emit({"pythonHelp13": all(name in help_text for name in ("init", "doctor", "chat", "dashboard", "serve", "cron", "workflow", "models", "tiers", "profile", "auth", "skill", "update"))})


def cli_call(argv):
    out = io.StringIO()
    err = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = cli_main(argv)
    return {"code": code, "stdout": out.getvalue(), "stderr": err.getvalue()}


def skill_export():
    destination = Path(os.environ["HOME"]) / "export"
    missing = cli_call(["skill", "export", "no-such-kit", "--to", str(destination)])
    written = cli_call(["skill", "export", "use-lohra", "--to", str(destination)])
    emit({"missing": missing, "written": written, "assetBytes": (destination / "use-lohra" / "SKILL.md").stat().st_size})


selected = sys.argv[1]
if selected == "memory-core": memory_core()
elif selected == "memory-utf16-mutant": memory_core(False)
elif selected == "memory-write-discipline": memory_discipline()
elif selected == "snapshot-freeze": snapshot_freeze()
elif selected == "prompt-snapshot": prompt_snapshot()
elif selected == "soul": soul()
elif selected == "project-discovery": project_discovery()
elif selected == "project-bounds": project_bounds()
elif selected == "instructions-unsafe": instructions_unsafe()
elif selected == "skills-index-edge": skills_index_edge()
elif selected == "skills-mutations": skills_mutations()
elif selected == "skills-validation": skills_validation()
elif selected == "env-upsert": env_upsert()
elif selected == "env-same-key": env_same_key()
elif selected == "wizard-gates": wizard_gates()
elif selected == "wizard-configure": wizard_configure(False)
elif selected == "wizard-eof": wizard_configure(True)
elif selected == "profile-errors": profile_errors()
elif selected == "profile-isolation": profile_isolation()
elif selected == "scope-shrink": scope_shrink()
elif selected == "skill-export": skill_export()
else: raise RuntimeError(f"unknown local-context mode {selected}")
