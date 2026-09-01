export function installNetworkSentinel(): Readonly<{
  attempts(): number;
  restore(): void;
}>;
