export type EventMap = Record<string, unknown>;

export class Emitter<M extends EventMap> {
  #handlers = new Map<keyof M, Set<(payload: unknown) => void>>();

  on<K extends keyof M>(type: K, handler: (payload: M[K]) => void): () => void {
    let set = this.#handlers.get(type);
    if (!set) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    const handlers = set;
    handlers.add(handler as (payload: unknown) => void);
    return () => {
      handlers.delete(handler as (payload: unknown) => void);
    };
  }

  emit<K extends keyof M>(type: K, payload: M[K]): void {
    const set = this.#handlers.get(type);
    if (!set) return;
    for (const handler of [...set]) handler(payload);
  }
}
