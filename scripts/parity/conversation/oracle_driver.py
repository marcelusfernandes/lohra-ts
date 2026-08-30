#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


def run(argv: list[str]) -> subprocess.CompletedProcess[str]:
    executable = Path(sys.executable).parent / "lohra"
    return subprocess.run(
        [str(executable), *argv],
        cwd=os.getcwd(),
        env=dict(os.environ),
        capture_output=True,
        text=True,
        check=False,
        timeout=60,
    )


def main() -> int:
    mode, *argv = sys.argv[1:]
    if mode != "resume":
        result = run(argv)
        sys.stdout.write(result.stdout)
        sys.stderr.write(result.stderr)
        return result.returncode
    divider = argv.index("--next-input")
    first_args = argv[:divider]
    next_input = argv[divider + 1]
    first = run(first_args)
    if first.returncode != 0:
        sys.stdout.write(first.stdout)
        sys.stderr.write(first.stderr)
        return first.returncode
    session_id = json.loads(first.stdout)["session_id"]
    second = run([first_args[0], next_input, *first_args[2:], "--session", session_id])
    sys.stdout.write(second.stdout)
    sys.stderr.write(first.stderr + second.stderr)
    return second.returncode


if __name__ == "__main__":
    raise SystemExit(main())
