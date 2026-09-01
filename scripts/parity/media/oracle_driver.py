#!/usr/bin/env python3
from __future__ import annotations

import base64
import hashlib
import json
import socket
import tempfile
from pathlib import Path

from lohra.imagegen.tool import ImageGenTool
from lohra.vision.content import image_part_from_file, image_part_from_url, text_part
from lohra.vision.tool import VisionTool


network_attempts = 0


def blocked(*_args, **_kwargs):
    global network_attempts
    network_attempts += 1
    raise RuntimeError("NETWORK_DISABLED")


socket.socket = blocked
socket.create_connection = blocked
socket.getaddrinfo = blocked


def project_image(part: dict) -> dict:
    value = part["image_url"]["url"]
    if value.startswith("data:"):
        header, payload = value.split(",", 1)
        decoded = base64.b64decode(payload, validate=True)
        return {
            "kind": "data",
            "mime": header.removeprefix("data:").removesuffix(";base64"),
            "length": len(value),
            "decoded_bytes": len(decoded),
            "sha256": hashlib.sha256(decoded).hexdigest(),
        }
    return {
        "kind": "url",
        "scheme": value.split(":", 1)[0],
        "length": len(value),
        "sha256": hashlib.sha256(value.encode()).hexdigest(),
        "has_query": "?" in value,
        "has_userinfo": "@" in value.split("/", 3)[2],
    }


with tempfile.TemporaryDirectory(prefix="lohra-t21-oracle-") as directory:
    root = Path(directory)
    image = root / "one.png"
    image.write_bytes(b"PNG-T21")
    url = "https://example.test/a?sig=CANARY-T21"

    vision_requests: list[list[dict]] = []

    def vision_runner(messages):
        vision_requests.append(messages)
        return "oracle-analysis"

    image_requests: list[dict] = []

    def image_runner(prompt, size, n):
        image_requests.append({"prompt": prompt, "size": size, "n": n})
        return ["<PATH>"]

    vision_result = json.loads(VisionTool(vision_runner).handle({"url": url, "prompt": "   "}))
    image_result = json.loads(
        ImageGenTool(image_runner).handle({"prompt": [1, "x"], "n": "2", "size": "512x512"})
    )

    output = {
        "vision": {
            "text": text_part("x"),
            "url": project_image(image_part_from_url(url)),
            "local": project_image(image_part_from_file(str(image))),
            "handler": {
                "result": vision_result,
                "prompt": vision_requests[0][0]["content"][0],
                "image": project_image(vision_requests[0][0]["content"][1]),
            },
        },
        "image_gen": {"result": image_result, "request": image_requests[0]},
        "network_attempts": network_attempts,
    }
    print(json.dumps(output, sort_keys=True, separators=(",", ":")))
