#!/usr/bin/env python3
from __future__ import annotations

import base64
import hashlib
import json
import re
import socket
import tempfile
from pathlib import Path


network_attempts = 0
_real_socket = socket.socket


def blocked(*_args, **_kwargs):
    global network_attempts
    network_attempts += 1
    raise RuntimeError("NETWORK_DISABLED")


class BlockedSocket(_real_socket):
    def connect(self, *_args, **_kwargs):
        return blocked()

    def connect_ex(self, *_args, **_kwargs):
        blocked()
        return 1


socket.socket = BlockedSocket
socket.create_connection = blocked
socket.getaddrinfo = blocked

try:
    socket.create_connection(("network-sentinel.invalid", 443))
    raise RuntimeError("NETWORK_SENTINEL_DID_NOT_BLOCK")
except RuntimeError as error:
    if str(error) != "NETWORK_DISABLED":
        raise
if network_attempts != 1:
    raise RuntimeError("NETWORK_SENTINEL_COUNTER")
network_attempts = 0

# Lohra is deliberately imported only after the network sentinel is installed.
from lohra.imagegen.tool import ImageGenTool
from lohra.vision.content import image_part_from_file, text_part
from lohra.vision.tool import VisionTool


def sha(value: bytes | str) -> str:
    if isinstance(value, str):
        value = value.encode()
    return hashlib.sha256(value).hexdigest()


def scrub_message(value: str) -> str:
    value = re.sub(r"data:[^\s]+", "<redacted-data-uri>", value)
    value = re.sub(r"https?://[^\s]+", "<redacted-url>", value)
    return value.replace("CANARY-T21", "<redacted-canary>")


def project_url(value: str) -> dict:
    if value.startswith("data:"):
        header, payload = value.split(",", 1) if "," in value else (value, "")
        try:
            decoded = base64.b64decode(payload, validate=True)
            valid = True
        except Exception:
            decoded = b""
            valid = False
        return {
            "kind": "data",
            "mime": header.removeprefix("data:").removesuffix(";base64"),
            "length": len(value),
            "encoded_length": len(payload),
            "decoded_bytes": len(decoded),
            "valid_base64": valid,
            "sha256": sha(decoded) if valid else None,
        }
    authority = value.split("/", 3)[2] if "://" in value else ""
    return {
        "kind": "url",
        "scheme": value.split(":", 1)[0] if ":" in value else None,
        "length": len(value),
        "sha256": sha(value),
        "has_query": "?" in value,
        "has_userinfo": "@" in authority,
    }


def vision_case(identifier: str, url: str, prompt="x") -> dict:
    requests: list[list[dict]] = []

    def runner(messages):
        requests.append(messages)
        return "oracle-analysis"

    try:
        result = json.loads(VisionTool(runner).handle({"url": url, "prompt": prompt}))
        source = None
        captured_prompt = None
        if requests:
            captured_prompt = requests[0][0]["content"][0]
            source = project_url(requests[0][0]["content"][1]["image_url"]["url"])
        value = {
            "status": "ok",
            "runner_calls": len(requests),
            "result": result,
            "prompt": captured_prompt,
            "source": source,
        }
    except Exception as error:
        value = {
            "status": "error",
            "runner_calls": len(requests),
            "error_type": type(error).__name__,
            "error": scrub_message(str(error)),
        }
    return {"id": identifier, "value": value}


def image_case(identifier: str, args: dict, returned: list[str] | None = None) -> dict:
    requests: list[dict] = []

    def runner(prompt, size, n):
        requests.append({"prompt": prompt, "size": size, "n": n})
        return [] if returned is None else returned

    try:
        result = json.loads(ImageGenTool(runner).handle(args))
        if "error" in result:
            value = {"status": "error", "runner_calls": len(requests)}
        else:
            files = []
            for path in result.get("images", []):
                candidate = Path(path)
                if candidate.is_file():
                    data = candidate.read_bytes()
                    files.append(
                        {
                            "bytes": len(data),
                            "mode": candidate.stat().st_mode & 0o777,
                            "sha256": sha(data),
                        }
                    )
            value = {
                "status": "ok",
                "runner_calls": len(requests),
                "request": requests[0] if requests else None,
                "result": {
                    "ok": result.get("ok") is True,
                    "image_count": len(result.get("images", [])),
                },
                "files": files,
            }
    except Exception as error:
        value = {
            "status": "error",
            "runner_calls": len(requests),
            "error_type": type(error).__name__,
            "error": scrub_message(str(error)),
        }
    return {"id": identifier, "value": value}


with tempfile.TemporaryDirectory(prefix="lohra-t21-oracle-") as directory:
    root = Path(directory)
    image = root / "one.png"
    image.write_bytes(b"PNG-T21")
    https_url = "https://example.test/a?sig=CANARY-T21"
    data_valid = "data:image/png;base64," + base64.b64encode(b"PNG-T21").decode()
    generated = root / "generated.png"
    generated.write_bytes(b"PNG-T21")
    generated.chmod(0o644)

    rows = [
        {"id": "vision.text-part", "value": text_part("x")},
        {"id": "vision.local-part", "value": project_url(image_part_from_file(str(image))["image_url"]["url"])},
        vision_case("vision.https", https_url, "   "),
        vision_case("vision.http", "http://example.test/a"),
        vision_case("vision.data-valid", data_valid),
        vision_case("vision.http-oversize", "https://example.test/" + "a" * 16_384),
        vision_case("vision.credentials", "https://u:p@example.test/a"),
        vision_case("vision.malformed", "not a url"),
        vision_case("vision.file-scheme", "file:///tmp/CANARY-T21"),
        vision_case("vision.javascript", "javascript:alert(1)"),
        vision_case("vision.localhost-dot", "http://localhost./a"),
        vision_case("vision.private-ip", "http://127.0.0.1/a"),
        vision_case("vision.reserved-ipv6", "http://[ff02::1]/a"),
        vision_case("vision.data-non-image", "data:text/plain;base64,QQ=="),
        vision_case("vision.data-invalid", "data:image/png;base64,%%%"),
        vision_case("vision.data-oversize", "data:image/png;base64," + "A" * 27_962_032),
        image_case("image.main", {"prompt": [1, "x"], "n": "2", "size": "512x512"}, [str(generated)]),
        image_case("image.prompt-true", {"prompt": True}),
        image_case("image.prompt-object", {"prompt": {"a": 1}}),
        image_case("image.prompt-blank", {"prompt": "   "}),
        image_case("image.n-string", {"prompt": "x", "n": "2"}),
        image_case("image.n-float", {"prompt": "x", "n": 1.9}),
        image_case("image.n-invalid", {"prompt": "x", "n": "1.9"}),
        image_case("image.n-clamp", {"prompt": "x", "n": 50}),
        image_case("image.size-invalid", {"prompt": "x", "size": "512x512"}),
        image_case("image.over-return-12", {"prompt": "x", "n": 1}, ["<PATH>"] * 12),
    ]
    print(
        json.dumps(
            {
                "rows": rows,
                "network_attempts": network_attempts,
                "network_sentinel_self_test": "blocked-before-lohra-imports",
            },
            sort_keys=True,
            separators=(",", ":"),
        )
    )
