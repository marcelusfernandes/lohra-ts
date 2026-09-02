"""Bounded process adapter used by the TypeScript parity harness."""

from __future__ import annotations

import base64
import json
import selectors
import signal
import subprocess
import sys
import time
from typing import Any


def emit(value: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=True, sort_keys=True))


def main() -> int:
    request = json.load(sys.stdin)
    timeout_seconds = float(request["timeoutMs"]) / 1000
    output_limit = int(request["maxOutputBytes"])
    try:
        process = subprocess.Popen(
            [request["executable"], *request["argv"]],
            cwd=request["cwd"],
            env=request["environment"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
        )
    except OSError as error:
        emit({"error": {"code": "PROCESS_SPAWN", "message": f"Python adapter target failed to spawn: {error}"}})
        return 0

    selector = selectors.DefaultSelector()
    assert process.stdout is not None
    assert process.stderr is not None
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    deadline = time.monotonic() + timeout_seconds
    failure: dict[str, str] | None = None
    while selector.get_map():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            failure = {
                "code": "PROCESS_TIMEOUT",
                "message": "Python adapter target exceeded its declared timeout",
            }
            break
        for key, _ in selector.select(min(remaining, 0.1)):
            chunk = key.fileobj.read1(65_536)
            if not chunk:
                selector.unregister(key.fileobj)
                continue
            target = buffers[key.data]
            target.extend(chunk)
            if len(target) > output_limit:
                failure = {
                    "code": "PROCESS_OUTPUT_LIMIT",
                    "message": "Python adapter target exceeded its output bound",
                }
                break
        if failure is not None:
            break

    if failure is not None:
        process.kill()
        process.stdout.close()
        process.stderr.close()
        process.wait()
        emit({"error": failure})
        return 0

    process.wait()
    stdout = bytes(buffers["stdout"])
    stderr = bytes(buffers["stderr"])

    return_code = process.returncode
    signal_name = None
    exit_code = return_code
    if return_code < 0:
        exit_code = None
        try:
            signal_name = signal.Signals(-return_code).name
        except ValueError:
            signal_name = f"SIG{-return_code}"
    emit(
        {
            "exitCode": exit_code,
            "signal": signal_name,
            "stdout": base64.b64encode(stdout).decode("ascii"),
            "stderr": base64.b64encode(stderr).decode("ascii"),
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
