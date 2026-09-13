// Issue #587 (epic #575, P11), acréscimo do orquestrador item 4: pin the
// invariant `buildTranscript`'s own doc claims for `headAlignedKeepCount`
// ("mirrors turnAlignedTailCount's own rule: never split a tool_calls
// message from its tool results") — with a `role: "tool"` message in the
// fixture, as the acréscimo asks for. `docs/context-compaction.md:224-226`
// promises this too.
//
// RED on purpose: `headAlignedKeepCount` (src/conversation/compaction.ts,
// out of issue #587's `Files`, see the comment `attemptCompaction`'s own
// module leaves at :64-76) backward-scans `for (cut = candidate; cut > 0;
// cut -= 1)` for the nearest `role: "user"` boundary and falls through to
// `return candidate` — a raw token cut — when index 0 is never reached and
// no `"user"` sits strictly between it and `candidate`. `turnAlignedTailCount`
// (same file) has a SAFE fallback (`messages.length`); this one does not.
// Sweeps every budget below the fixture's own full size instead of pinning
// one keepCount, so the test survives any fix strategy or estimator drift:
// whenever the transcript keeps the `assistant` message that made the tool
// call, it must also keep that call's own `tool` result.
import { describe, expect, it } from "vitest";

import { buildTranscript } from "../src/conversation/compaction.js";
import { estimateTokens } from "../src/context/token-estimate.js";

describe("buildTranscript — tool_calls/tool alignment (issue #587)", () => {
  it("never keeps an assistant tool-call message without its own tool result", () => {
    const messages = [
      { role: "user", content: "u0" },
      {
        role: "assistant",
        content: "call",
        tool_calls: [{ id: "1", type: "function", function: { name: "x", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "1", content: "result-one" },
      { role: "user", content: "u2 next turn" },
      { role: "assistant", content: "final answer here" },
    ];
    const fullTokens = estimateTokens(messages).tokens;
    const violations: number[] = [];
    for (let budget = 1; budget < fullTokens; budget += 1) {
      const { transcript } = buildTranscript(messages, budget);
      if (transcript.includes("assistant: call") && !transcript.includes("result-one")) {
        violations.push(budget);
      }
    }
    expect(violations).toEqual([]);
  });
});
