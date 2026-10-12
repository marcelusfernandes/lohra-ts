export function createCancellationNoticeTracker(
  _input: string,
  _signal: AbortSignal,
): {
  dispatch<T>(name: string, run: () => Promise<T>): Promise<T>;
  context(): string;
  dispose(): void;
} {
  throw new Error("not implemented: cancellation notice tracker");
}
