export type ToolArguments = Readonly<Record<string, unknown>>;
export type ToolKwargs = Readonly<Record<string, unknown>>;
export type ToolHandler = (args: ToolArguments, kwargs?: ToolKwargs) => string | Promise<string>;
export type ToolCheck = () => boolean;

export interface ToolFunctionSchema {
  readonly description: unknown;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly name?: string;
}

export interface ToolDefinition {
  readonly type: "function";
  readonly function: ToolFunctionSchema & { readonly name: string };
}

export interface ToolRegistration {
  readonly name: string;
  readonly toolset: string;
  readonly schema: ToolFunctionSchema;
  readonly handler: ToolHandler;
  readonly checkFn?: ToolCheck;
  readonly requiresEnv?: readonly string[];
  readonly isAsync?: boolean;
  readonly description?: string;
  readonly emoji?: string;
  readonly maxResultSizeChars?: number | null;
  readonly override?: boolean;
}

export interface ToolEntry extends Omit<ToolRegistration, "override" | "schema"> {
  readonly schema: ToolFunctionSchema & { readonly name: string };
}

export type RegistryDispatch = (
  name: string,
  args: ToolArguments,
  kwargs?: ToolKwargs,
) => Promise<string>;
