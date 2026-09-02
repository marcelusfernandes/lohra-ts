"""Generates src/web/html5-entities.ts from the pinned oracle's
html.entities.html5 table (Python 3.12.10). Read-only over the oracle."""
import html.entities
import json

entries = []
for name, replacement in html.entities.html5.items():
    entries.append({"name": name, "value": replacement})
entries.sort(key=lambda entry: (-len(entry["name"]), entry["name"]))
body = []
body.append("/* Generated from the pinned Python oracle (3.12.10 html.entities.html5).")
body.append(" * Preserve verbatim; regenerate only against a new pinned oracle. */")
body.append("")
body.append("export const HTML5_ENTITIES: readonly { readonly name: string; readonly value: string }[] = [")
for entry in entries:
    body.append(f"  {{ name: {json.dumps(entry['name'])}, value: {json.dumps(entry['value'])} }},")
body.append("];")
body.append("")
with open("src/web/html5-entities.ts", "w") as handle:
    handle.write("\n".join(body))
print(f"wrote {len(entries)} entities")
