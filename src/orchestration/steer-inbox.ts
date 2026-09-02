/**
 * The busy/queued-in-pool steer form (contract decision 6 / L6): pending
 * steer texts merge into a single <system-reminder> message, newline-joined,
 * drained at the top of every iteration (the first included). Empty input
 * produces no message at all — this is what drainMessages returns when
 * nothing is pending, distinct from the idle/terminal form (raw text opening
 * a new turn), which is not this function's concern.
 */
export function wrapSteerInbox(
  pending: readonly string[],
): readonly Readonly<Record<string, unknown>>[] {
  if (pending.length === 0) return [];
  return [
    { role: "user", content: `<system-reminder>\n${pending.join("\n")}\n</system-reminder>` },
  ];
}
