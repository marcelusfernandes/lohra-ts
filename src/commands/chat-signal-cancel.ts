import { registerShutdownTrigger } from "../cli/shutdown-trigger.js";

export interface ChatSignalCancellation {
  readonly signal: AbortSignal;
  dispose(): void;
}

export function createChatSignalCancellation(
  register: (handler: () => void) => () => void = registerShutdownTrigger,
): ChatSignalCancellation {
  void register;
  throw new Error("not implemented: chat signal cancellation");
}
