export interface NativeRouteSelection {
  readonly mode: "standard" | "native-negative" | "native-positive";
  readonly os: "ubuntu" | "windows";
  readonly basePayload: string;
  readonly head: string;
  readonly mergeBase: string;
  readonly slug?: string;
  readonly sources?: readonly string[];
}

export function selectNativeRoute(
  _root: string,
  _basePayload: string,
  _head: string,
): NativeRouteSelection {
  throw new Error("NATIVE_ROUTE_NOT_IMPLEMENTED");
}
