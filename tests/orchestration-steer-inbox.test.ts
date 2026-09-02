import { describe, expect, it } from "vitest";

import { wrapSteerInbox } from "../src/orchestration/steer-inbox.js";

describe("wrapSteerInbox (contract L6 — busy/queued-in-pool form)", () => {
  it("returns no message when there is nothing pending", () => {
    expect(wrapSteerInbox([])).toEqual([]);
  });

  it("wraps a single pending text in a <system-reminder> message", () => {
    expect(wrapSteerInbox(["STEER-ALPHA"])).toEqual([
      { role: "user", content: "<system-reminder>\nSTEER-ALPHA\n</system-reminder>" },
    ]);
  });

  it("merges multiple pending texts into ONE <system-reminder> message, newline-joined", () => {
    expect(wrapSteerInbox(["STEER-ALPHA", "STEER-BRAVO"])).toEqual([
      {
        role: "user",
        content: "<system-reminder>\nSTEER-ALPHA\nSTEER-BRAVO\n</system-reminder>",
      },
    ]);
  });
});
