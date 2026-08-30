from __future__ import annotations

import json
import os
import socket
from pathlib import Path
from typing import Any


output = os.environ.get("LOHRA_SOCKET_SENTINEL")
if not output:
    raise RuntimeError("LOHRA_SOCKET_SENTINEL is required")


def record(kind: str) -> None:
    with Path(output).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"kind": kind}, separators=(",", ":")) + "\n")


record("armed")

original_bind = socket.socket.bind
original_listen = socket.socket.listen


def sentinel_bind(instance: socket.socket, *args: Any, **kwargs: Any) -> Any:
    record("bind")
    return original_bind(instance, *args, **kwargs)


def sentinel_listen(instance: socket.socket, *args: Any, **kwargs: Any) -> Any:
    record("listen")
    return original_listen(instance, *args, **kwargs)


socket.socket.bind = sentinel_bind
socket.socket.listen = sentinel_listen
