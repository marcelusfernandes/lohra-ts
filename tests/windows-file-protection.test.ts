import { describe, expect, it } from "vitest";

import { prepareWindowsPrivateDestination } from "../src/security/windows-file-protection.js";

describe("windows private destination", () => {
  it("rejects a relative path before creating a destination", () => {
    expect(() => prepareWindowsPrivateDestination("relative/private.json")).toThrow(/absolute/i);
  });
});
