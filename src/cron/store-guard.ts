/** Cross-process guard for one cron store. Implemented after the red regression. */
export function withCronStoreGuard<T>(_path: string, _fn: () => T): T {
  throw new Error("not implemented: withCronStoreGuard");
}
