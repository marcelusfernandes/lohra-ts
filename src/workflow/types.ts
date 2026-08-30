export type JsonRecord = Readonly<Record<string, unknown>>;

export interface SpecIssueInit {
  readonly rule: string;
  readonly message: string;
  readonly example?: string | null;
  readonly nodeId?: string | null;
  readonly field?: string | null;
}

export class SpecIssue {
  readonly rule: string;
  readonly message: string;
  readonly example: string | null;
  readonly nodeId: string | null;
  readonly field: string | null;

  constructor(init: SpecIssueInit) {
    this.rule = init.rule;
    this.message = init.message;
    this.example = init.example ?? null;
    this.nodeId = init.nodeId ?? null;
    this.field = init.field ?? null;
    Object.freeze(this);
  }

  toString(): string {
    const where = this.nodeId === null ? "" : ` ${this.nodeId}`;
    const field = this.field === null ? "" : ` .${this.field}`;
    const example =
      this.example === null ? "" : `\n    e.g. ${this.example.replaceAll("\n", "\n    ")}`;
    return `[${this.rule}]${where}${field}: ${this.message}${example}`;
  }
}

export class ValidationError {
  readonly kind = "validation_error";
  readonly issues: readonly SpecIssue[];
  readonly message: string;

  constructor(issues: readonly SpecIssue[]) {
    this.issues = Object.freeze([...issues]);
    this.message = this.issues.map((issue) => issue.toString()).join("\n");
    Object.freeze(this);
  }
}

export function isValidationError(value: unknown): value is ValidationError {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "validation_error" &&
    Array.isArray((value as { issues?: unknown }).issues) &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

export class Node {
  readonly id: string;
  readonly type: string;
  readonly fields: JsonRecord;

  constructor(id: string, type: string, fields: Record<string, unknown>) {
    this.id = id;
    this.type = type;
    this.fields = deepCopyReadonly(fields);
    Object.freeze(this);
  }

  get label(): string {
    const value = this.fields.label;
    return typeof value === "string" ? value : this.id;
  }

  get phase(): string | null {
    const value = this.fields.phase;
    return typeof value === "string" ? value : null;
  }

  get required(): boolean {
    return Boolean(this.fields.required);
  }
}

export class WorkflowSpec {
  readonly meta: JsonRecord;
  readonly inputs: JsonRecord;
  readonly schemas: JsonRecord;
  readonly nodes: readonly Node[];
  readonly warnings: readonly string[];

  constructor(init: {
    meta: Record<string, unknown>;
    inputs: Record<string, unknown>;
    schemas: Record<string, unknown>;
    nodes: readonly Node[];
    warnings?: readonly string[];
  }) {
    this.meta = deepCopyReadonly(init.meta);
    this.inputs = deepCopyReadonly(init.inputs);
    this.schemas = deepCopyReadonly(init.schemas);
    this.nodes = Object.freeze([...init.nodes]);
    this.warnings = Object.freeze([...(init.warnings ?? [])]);
    Object.freeze(this);
  }

  node(id: string): Node | null {
    return this.nodes.find((node) => node.id === id) ?? null;
  }

  get name(): string {
    const value = this.meta.name;
    return typeof value === "string" && value !== "" ? value : "workflow";
  }
}

export function deepCopyReadonly<T>(value: T): T {
  if (Array.isArray(value)) {
    const items = value as unknown[];
    return Object.freeze(items.map((item) => deepCopyReadonly(item))) as T;
  }
  if (value !== null && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype === Object.prototype || prototype === null) {
      const copied: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        copied[key] = deepCopyReadonly(item);
      }
      return Object.freeze(copied) as T;
    }
  }
  return value;
}
