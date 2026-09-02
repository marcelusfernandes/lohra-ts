import { describe, expect, it } from "vitest";

import { HarnessError } from "../../scripts/parity/errors.js";
import { assertPreconditions } from "../../scripts/parity/preconditions.js";

describe("parity preconditions", () => {
  it("records a declared closed port", () => {
    expect(
      assertPreconditions(
        [{ kind: "tcp-port-closed", host: "127.0.0.1", port: 11_434 }],
        { timeoutMs: 1_000, maxOutputBytes: 16_384 },
        () => false,
      ),
    ).toEqual([{ kind: "tcp-port-closed", host: "127.0.0.1", port: 11_434, status: "passed" }]);
  });

  it("fails before execution when the declared port has a listener", () => {
    expect(() =>
      assertPreconditions(
        [{ kind: "tcp-port-closed", host: "127.0.0.1", port: 11_434 }],
        { timeoutMs: 1_000, maxOutputBytes: 16_384 },
        () => true,
      ),
    ).toThrow(expect.objectContaining<Partial<HarnessError>>({ code: "PRECONDITION_PORT_IN_USE" }));
  });
});
