import { describe, expect, it } from "vitest";

import { safeMediaMessage, safeMediaValue } from "../src/media/index.js";

describe("media redaction", () => {
  it("redacts urls, data uris and credentials in flat messages", () => {
    const message = safeMediaMessage(
      new Error(
        "see https://example.test/a?secret=CANARY-URL and data:image/png;base64,CANARYDATA== Bearer CANARY-TOKEN",
      ),
    );
    expect(message).not.toContain("CANARY-URL");
    expect(message).not.toContain("data:image/png;base64,CANARYDATA");
    expect(message).not.toContain("Bearer CANARY-TOKEN");
    expect(message).toContain("Error:");
  });

  it("redacts recursively across nested strings, errors and requests", () => {
    const nested = {
      request: {
        url: "https://example.test/vault?key=CANARY-KEY",
        headers: ["Bearer CANARY-NESTED", "data:image/png;base64,Q0FOQVJZ"],
        error: new Error("nested https://example.test/leak?sig=CANARY-DEEP"),
      },
      trailing: "clean",
    };
    const projected = safeMediaValue(nested) as Record<string, unknown>;
    const serialized = JSON.stringify(projected);
    for (const canary of ["CANARY-KEY", "CANARY-NESTED", "Q0FOQVJZ", "CANARY-DEEP"]) {
      expect(serialized).not.toContain(canary);
    }
    expect(serialized).toContain("clean");
    const deepError = (projected["request"] as Record<string, unknown>)["error"] as Record<
      string,
      unknown
    >;
    expect(deepError["name"]).toBe("Error");
  });

  it("caps recursion depth instead of following cyclic structures", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    cyclic["url"] = "https://example.test/a?secret=CANARY-CYCLE";
    const projected = safeMediaValue(cyclic) as Record<string, unknown>;
    expect(JSON.stringify(projected)).not.toContain("CANARY-CYCLE");
    expect(JSON.stringify(projected)).toContain("<redacted-depth>");
  });

  it("preserves counts, hashes and non-string values", () => {
    const projected = safeMediaValue({
      status: "error",
      count: 3,
      sha256: "abc123",
      flags: [true, null, 7],
    }) as Record<string, unknown>;
    expect(projected).toEqual({
      status: "error",
      count: 3,
      sha256: "abc123",
      flags: [true, null, 7],
    });
  });
});
