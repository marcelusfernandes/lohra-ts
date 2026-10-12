import { registerShutdownTrigger } from "../cli/shutdown-trigger.js";

export interface ChatSignalCancellation {
  readonly signal: AbortSignal;
  dispose(): void;
}

export function createChatSignalCancellation(
  register: (handler: () => void) => () => void = registerShutdownTrigger,
): ChatSignalCancellation {
  const controller = new AbortController();
  const unregister = register(() => {
    controller.abort(new Error("chat interrupted by SIGINT or SIGTERM"));
  });
  return {
    signal: controller.signal,
    dispose: unregister,
  };
}
