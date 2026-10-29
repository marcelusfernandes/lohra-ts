import { expect, it } from "vitest";
import { Prompter } from "../src/onboarding/wizard.js";
it("propagates a read failure instead of accepting a default", async () => {
  const prompt = new Prompter(
    () => {
      throw new Error("terminal input ended");
    },
    () => undefined,
  );
  await expect(async () => await prompt.ask("provider", "anthropic")).rejects.toThrow(
    "terminal input ended",
  );
});
