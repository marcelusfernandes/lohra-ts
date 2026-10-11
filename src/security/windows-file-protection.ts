export interface WindowsFileProtection {
  verifyBeforeWrite(): void;
  verifyBeforePublication(source: string): void;
  verifyAfterPublication(): void;
}

export function prepareWindowsPrivateDestination(_destination: string): WindowsFileProtection {
  throw new Error("not implemented: prepareWindowsPrivateDestination");
}
