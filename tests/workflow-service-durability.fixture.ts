import type {
  ChildRuntime,
  LeafSandboxHandle,
  LeafSandboxInstallation,
  LeafToolDispatch,
} from "../src/workflow/runtime.js";

/**
 * A reference `ChildRuntime` that really sandboxes its leaves. It keeps ONE
 * installation per acquisition, keyed by that acquisition's fence, and every
 * leaf tool call runs through the wrapper the service installed for it — so
 * these tests exercise enforcement, not a no-op that merely accepts the call.
 */
export interface LeafSandboxed {
  /** Run a leaf tool through the wrapper installed for `fence`. */
  leafTool(fence: number, name: string, args: Readonly<Record<string, unknown>>): string;
  retiredTool(fence: number, name: string, args: Readonly<Record<string, unknown>>): string;
  installedFences(): readonly number[];
  disposedFences(): readonly number[];
  baseCalls(): readonly string[];
}

export function withLeafSandbox<T extends ChildRuntime>(runtime: T): T & LeafSandboxed {
  const installed = new Map<number, LeafToolDispatch>();
  const retired = new Map<number, LeafToolDispatch>();
  const disposed: number[] = [];
  const seen: string[] = [];
  const base: LeafToolDispatch = (name) => {
    seen.push(name);
    return `allowed:${name}`;
  };
  return Object.assign(runtime, {
    installLeafSandbox(installation: LeafSandboxInstallation): LeafSandboxHandle {
      installed.set(installation.fence, installation.wrap(base));
      return {
        dispose: () => {
          // ONLY this acquisition's installation
          const dispatch = installed.get(installation.fence);
          if (dispatch !== undefined) retired.set(installation.fence, dispatch);
          installed.delete(installation.fence);
          disposed.push(installation.fence);
        },
      };
    },
    leafTool(fence: number, name: string, args: Readonly<Record<string, unknown>>): string {
      const dispatch = installed.get(fence);
      if (dispatch === undefined)
        throw new Error(`no leaf sandbox installed for fence ${String(fence)}`);
      return dispatch(name, args);
    },
    /** A wrapper from an acquisition that has already ended. */
    retiredTool(fence: number, name: string, args: Readonly<Record<string, unknown>>): string {
      const dispatch = retired.get(fence);
      if (dispatch === undefined) throw new Error(`no retired sandbox for fence ${String(fence)}`);
      return dispatch(name, args);
    },
    installedFences: (): readonly number[] => [...installed.keys()].sort((a, b) => a - b),
    disposedFences: (): readonly number[] => [...disposed],
    baseCalls: (): readonly string[] => [...seen],
  });
}

export function spec(): Record<string, unknown> {
  return {
    meta: { name: "durable" },
    nodes: [{ id: "a", type: "agent", prompt: "do it" }],
  };
}
