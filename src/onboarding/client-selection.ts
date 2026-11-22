import type { SkillClient } from "../skills/clients.js";

export const CLIENT_SELECTION_TITLE = "clients — arrows move, Space toggles, Enter confirms";
export const CLIENT_SELECTION_HINT =
  "Unchecking a client does not uninstall it. Use `lohra skills remove` to remove one.";

/** Line fallback for an injected reader. The interactive init uses the keyboard selector. */
export function clientsFromLine(
  _answer: string,
  _clients: readonly SkillClient[],
): readonly SkillClient[] {
  throw new Error("not implemented");
}

/**
 * Install or update the packaged kit on the selected clients only.
 * Returns the number of clients whose install failed.
 */
export function installSelectedClients(
  _clients: readonly SkillClient[],
  _note: (line: string) => void,
): number {
  throw new Error("not implemented");
}
