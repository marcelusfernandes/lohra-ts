export interface PreparedWindowsHelper {
  readonly outputDir: string;
  readonly executablePath: string;
  readonly manifestPath: string;
}

export interface PrepareWindowsHelperOptions {
  readonly sources: readonly string[];
  readonly outputDir: string;
  readonly compilerPath: string;
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
  readonly runCompiler?: (
    command: string,
    argv: readonly string[],
    options: {
      readonly cwd: string;
      readonly timeout: number;
      readonly maxBuffer: number;
      readonly shell: false;
      readonly windowsHide: true;
    },
  ) => {
    readonly status: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: Buffer;
    readonly stderr: Buffer;
    readonly error?: Error;
  };
}

export function prepareWindowsHelper(_options: PrepareWindowsHelperOptions): PreparedWindowsHelper {
  throw new Error("not implemented");
}

export function verifyWindowsHelper(_descriptor: PreparedWindowsHelper): string {
  throw new Error("not implemented");
}
