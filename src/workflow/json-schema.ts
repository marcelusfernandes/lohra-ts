type Schema = boolean | Readonly<Record<string, unknown>>;

export class SchemaDefinitionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SchemaDefinitionError";
  }
}

const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function record(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new SchemaDefinitionError(`${path} must be a schema object or boolean`);
  return value as Readonly<Record<string, unknown>>;
}

function schemas(value: unknown, path: string): readonly Schema[] {
  if (!Array.isArray(value)) throw new SchemaDefinitionError(`${path} must be an array of schemas`);
  return value.map((item, index) => schema(item, `${path}[${String(index)}]`));
}

function schema(value: unknown, path: string): Schema {
  return typeof value === "boolean" ? value : record(value, path);
}

function numberKeyword(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || Number.isNaN(value))
    throw new SchemaDefinitionError(`${path} must be a number`);
  return value;
}

function integerKeyword(value: unknown, path: string): number | undefined {
  const parsed = numberKeyword(value, path);
  if (parsed !== undefined && (!Number.isInteger(parsed) || parsed < 0))
    throw new SchemaDefinitionError(`${path} must be a non-negative integer`);
  return parsed;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
    );
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).toSorted();
    const rightKeys = Object.keys(rightRecord).toSorted();
    return (
      deepEqual(leftKeys, rightKeys) &&
      leftKeys.every((key) => deepEqual(leftRecord[key], rightRecord[key]))
    );
  }
  return false;
}

function matchesType(value: unknown, expected: string): boolean {
  if (expected === "null") return value === null;
  if (expected === "array") return Array.isArray(value);
  if (expected === "object")
    return value !== null && typeof value === "object" && !Array.isArray(value);
  if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === expected;
}

function pointer(root: Schema, reference: string): Schema {
  if (!reference.startsWith("#/")) throw new SchemaDefinitionError(`unsupported $ref ${reference}`);
  let current: unknown = root;
  for (const encoded of reference.slice(2).split("/")) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    current = record(current, reference)[key];
  }
  return schema(current, reference);
}

function schemaChildren(raw: Readonly<Record<string, unknown>>): readonly Schema[] {
  const children: Schema[] = [];
  for (const keyword of [
    "$defs",
    "definitions",
    "properties",
    "patternProperties",
    "dependentSchemas",
  ] as const) {
    if (raw[keyword] === undefined) continue;
    const entries = record(raw[keyword], `$.${keyword}`);
    for (const [key, child] of Object.entries(entries))
      children.push(schema(child, `$.${keyword}.${key}`));
  }
  for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"] as const)
    if (raw[keyword] !== undefined) children.push(...schemas(raw[keyword], `$.${keyword}`));
  for (const keyword of [
    "not",
    "if",
    "then",
    "else",
    "items",
    "contains",
    "additionalProperties",
    "propertyNames",
    "unevaluatedProperties",
    "unevaluatedItems",
  ] as const)
    if (raw[keyword] !== undefined) children.push(schema(raw[keyword], `$.${keyword}`));
  return children;
}

function findSchema(
  root: Schema,
  predicate: (candidate: Readonly<Record<string, unknown>>) => boolean,
): Schema | undefined {
  const seen = new Set<Readonly<Record<string, unknown>>>();
  const visit = (candidate: Schema): Schema | undefined => {
    if (typeof candidate === "boolean" || seen.has(candidate)) return undefined;
    seen.add(candidate);
    if (predicate(candidate)) return candidate;
    for (const child of schemaChildren(candidate)) {
      const found = visit(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(root);
}

function namedAnchor(root: Schema, name: string, dynamic: boolean): Schema | undefined {
  return findSchema(
    root,
    (candidate) =>
      candidate[dynamic ? "$dynamicAnchor" : "$anchor"] === name ||
      (!dynamic && candidate.$dynamicAnchor === name),
  );
}

function resolveReference(root: Schema, reference: string, dynamic = false): Schema {
  if (reference === "#") return root;
  if (reference.startsWith("#/")) return pointer(root, reference);
  if (reference.startsWith("#")) {
    const name = decodeURIComponent(reference.slice(1));
    const anchored = namedAnchor(root, name, dynamic);
    if (anchored !== undefined) return anchored;
    throw new SchemaDefinitionError(`unresolved local reference ${reference}`);
  }
  const fragmentAt = reference.indexOf("#");
  const resourceId = fragmentAt < 0 ? reference : reference.slice(0, fragmentAt);
  const resource = findSchema(root, (candidate) => candidate.$id === resourceId);
  if (resource === undefined)
    throw new SchemaDefinitionError(
      `unresolved reference ${reference}; external resolution disabled`,
    );
  if (fragmentAt < 0 || fragmentAt === reference.length - 1) return resource;
  const fragment = reference.slice(fragmentAt);
  if (fragment.startsWith("#/")) return pointer(resource, fragment);
  const anchored = namedAnchor(resource, decodeURIComponent(fragment.slice(1)), dynamic);
  if (anchored !== undefined) return anchored;
  throw new SchemaDefinitionError(`unresolved local reference ${reference}`);
}

function patternEntries(raw: unknown, path: string): readonly (readonly [RegExp, Schema])[] {
  const patterns = raw === undefined ? {} : record(raw, path);
  return Object.entries(patterns).map(([pattern, child]) => {
    try {
      return [new RegExp(pattern, "u"), schema(child, `${path}.${pattern}`)] as const;
    } catch (error) {
      throw new SchemaDefinitionError(`${path} contains invalid regex`, { cause: error });
    }
  });
}

function evaluatedObjectKeys(
  value: Readonly<Record<string, unknown>>,
  raw: Schema,
  root: Schema,
  includeUnevaluated = true,
): Set<string> {
  const evaluated = new Set<string>();
  if (typeof raw === "boolean") return evaluated;
  if (typeof raw.$ref === "string")
    for (const key of evaluatedObjectKeys(value, resolveReference(root, raw.$ref), root))
      evaluated.add(key);
  if (typeof raw.$dynamicRef === "string")
    for (const key of evaluatedObjectKeys(
      value,
      resolveReference(root, raw.$dynamicRef, true),
      root,
    ))
      evaluated.add(key);
  const properties = raw.properties === undefined ? {} : record(raw.properties, "$.properties");
  const patterns = patternEntries(raw.patternProperties, "$.patternProperties");
  for (const key of Object.keys(value)) {
    if (properties[key] !== undefined || patterns.some(([pattern]) => pattern.test(key)))
      evaluated.add(key);
  }
  if (raw.additionalProperties !== undefined)
    for (const key of Object.keys(value)) evaluated.add(key);
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    if (raw[keyword] === undefined) continue;
    for (const child of schemas(raw[keyword], `$.${keyword}`)) {
      if (keyword === "allOf" || validate(value, child, "$", root).length === 0)
        for (const key of evaluatedObjectKeys(value, child, root)) evaluated.add(key);
    }
  }
  if (raw.if !== undefined) {
    const condition = schema(raw.if, "$.if");
    const matches = validate(value, condition, "$", root).length === 0;
    for (const key of evaluatedObjectKeys(value, condition, root)) evaluated.add(key);
    const branch = matches ? raw.then : raw.else;
    if (branch !== undefined)
      for (const key of evaluatedObjectKeys(
        value,
        schema(branch, matches ? "$.then" : "$.else"),
        root,
      ))
        evaluated.add(key);
  }
  if (raw.dependentSchemas !== undefined) {
    const dependencies = record(raw.dependentSchemas, "$.dependentSchemas");
    for (const [key, child] of Object.entries(dependencies))
      if (key in value)
        for (const annotated of evaluatedObjectKeys(
          value,
          schema(child, `$.dependentSchemas.${key}`),
          root,
        ))
          evaluated.add(annotated);
  }
  if (includeUnevaluated && raw.unevaluatedProperties !== undefined)
    for (const key of Object.keys(value)) evaluated.add(key);
  return evaluated;
}

function evaluatedItemIndexes(
  value: readonly unknown[],
  raw: Schema,
  root: Schema,
  includeUnevaluated = true,
): Set<number> {
  const evaluated = new Set<number>();
  if (typeof raw === "boolean") return evaluated;
  if (typeof raw.$ref === "string")
    for (const index of evaluatedItemIndexes(value, resolveReference(root, raw.$ref), root))
      evaluated.add(index);
  if (typeof raw.$dynamicRef === "string")
    for (const index of evaluatedItemIndexes(
      value,
      resolveReference(root, raw.$dynamicRef, true),
      root,
    ))
      evaluated.add(index);
  const prefix = raw.prefixItems === undefined ? [] : schemas(raw.prefixItems, "$.prefixItems");
  for (let index = 0; index < Math.min(prefix.length, value.length); index += 1)
    evaluated.add(index);
  if (raw.items !== undefined)
    for (let index = prefix.length; index < value.length; index += 1) evaluated.add(index);
  if (raw.contains !== undefined) {
    const contains = schema(raw.contains, "$.contains");
    for (let index = 0; index < value.length; index += 1)
      if (validate(value[index], contains, `$[${String(index)}]`, root).length === 0)
        evaluated.add(index);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    if (raw[keyword] === undefined) continue;
    for (const child of schemas(raw[keyword], `$.${keyword}`)) {
      if (keyword === "allOf" || validate(value, child, "$", root).length === 0)
        for (const index of evaluatedItemIndexes(value, child, root)) evaluated.add(index);
    }
  }
  if (includeUnevaluated && raw.unevaluatedItems !== undefined)
    for (let index = 0; index < value.length; index += 1) evaluated.add(index);
  return evaluated;
}

function validate(value: unknown, raw: Schema, path: string, root: Schema): string[] {
  if (raw === true) return [];
  if (raw === false) return [`${path}: false schema rejects every value`];
  const errors: string[] = [];
  if (typeof raw.$ref === "string")
    errors.push(...validate(value, resolveReference(root, raw.$ref), path, root));
  if (typeof raw.$dynamicRef === "string")
    errors.push(...validate(value, resolveReference(root, raw.$dynamicRef, true), path, root));
  const types = raw.type === undefined ? [] : Array.isArray(raw.type) ? raw.type : [raw.type];
  if (types.some((item) => typeof item !== "string" || !TYPES.has(item)))
    throw new SchemaDefinitionError(`${path}.type must name JSON Schema types`);
  if (types.length > 0 && !types.some((item) => matchesType(value, item as string)))
    return [`${path}: expected ${types.join(" or ")}`];

  if (raw.const !== undefined && !deepEqual(value, raw.const))
    errors.push(`${path}: value does not equal const`);
  if (raw.enum !== undefined) {
    if (!Array.isArray(raw.enum) || raw.enum.length === 0)
      throw new SchemaDefinitionError(`${path}.enum must be a non-empty array`);
    if (!raw.enum.some((item) => deepEqual(value, item)))
      errors.push(`${path}: value is not in enum`);
  }

  for (const keyword of ["allOf", "anyOf", "oneOf"] as const) {
    if (raw[keyword] === undefined) continue;
    const alternatives = schemas(raw[keyword], `${path}.${keyword}`);
    const matches = alternatives.filter(
      (alternative) => validate(value, alternative, path, root).length === 0,
    ).length;
    if (keyword === "allOf" && matches !== alternatives.length)
      errors.push(`${path}: allOf failed`);
    if (keyword === "anyOf" && matches === 0) errors.push(`${path}: anyOf failed`);
    if (keyword === "oneOf" && matches !== 1)
      errors.push(`${path}: oneOf matched ${String(matches)} schemas`);
  }
  if (
    raw.not !== undefined &&
    validate(value, schema(raw.not, `${path}.not`), path, root).length === 0
  )
    errors.push(`${path}: not schema matched`);
  if (raw.if !== undefined) {
    const condition = validate(value, schema(raw.if, `${path}.if`), path, root).length === 0;
    const branch = condition ? raw.then : raw.else;
    if (branch !== undefined)
      errors.push(
        ...validate(value, schema(branch, `${path}.${condition ? "then" : "else"}`), path, root),
      );
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const minimum = numberKeyword(raw.minimum, `${path}.minimum`);
    const maximum = numberKeyword(raw.maximum, `${path}.maximum`);
    const exclusiveMinimum = numberKeyword(raw.exclusiveMinimum, `${path}.exclusiveMinimum`);
    const exclusiveMaximum = numberKeyword(raw.exclusiveMaximum, `${path}.exclusiveMaximum`);
    const multipleOf = numberKeyword(raw.multipleOf, `${path}.multipleOf`);
    if (minimum !== undefined && value < minimum)
      errors.push(`${path}: ${String(value)} is less than minimum ${String(minimum)}`);
    if (maximum !== undefined && value > maximum)
      errors.push(`${path}: ${String(value)} exceeds maximum ${String(maximum)}`);
    if (exclusiveMinimum !== undefined && value <= exclusiveMinimum)
      errors.push(`${path}: value must exceed ${String(exclusiveMinimum)}`);
    if (exclusiveMaximum !== undefined && value >= exclusiveMaximum)
      errors.push(`${path}: value must be below ${String(exclusiveMaximum)}`);
    if (multipleOf !== undefined) {
      if (multipleOf <= 0) throw new SchemaDefinitionError(`${path}.multipleOf must be positive`);
      const quotient = value / multipleOf;
      if (Math.trunc(quotient) !== quotient)
        errors.push(`${path}: value is not a multiple of ${String(multipleOf)}`);
    }
  }

  if (typeof value === "string") {
    const length = Array.from(value).length;
    const minLength = integerKeyword(raw.minLength, `${path}.minLength`);
    const maxLength = integerKeyword(raw.maxLength, `${path}.maxLength`);
    if (minLength !== undefined && length < minLength)
      errors.push(`${path}: string is shorter than ${String(minLength)}`);
    if (maxLength !== undefined && length > maxLength)
      errors.push(`${path}: string is longer than ${String(maxLength)}`);
    if (raw.pattern !== undefined) {
      if (typeof raw.pattern !== "string")
        throw new SchemaDefinitionError(`${path}.pattern must be a string`);
      let pattern: RegExp;
      try {
        pattern = new RegExp(raw.pattern, "u");
      } catch (error) {
        throw new SchemaDefinitionError(`${path}.pattern is invalid`, { cause: error });
      }
      if (!pattern.test(value))
        errors.push(`${path}: string does not match pattern ${raw.pattern}`);
    }
  }

  if (Array.isArray(value)) {
    const minItems = integerKeyword(raw.minItems, `${path}.minItems`);
    const maxItems = integerKeyword(raw.maxItems, `${path}.maxItems`);
    if (minItems !== undefined && value.length < minItems)
      errors.push(`${path}: array has fewer than ${String(minItems)} items`);
    if (maxItems !== undefined && value.length > maxItems)
      errors.push(`${path}: array has more than ${String(maxItems)} items`);
    if (raw.uniqueItems !== undefined && typeof raw.uniqueItems !== "boolean")
      throw new SchemaDefinitionError(`${path}.uniqueItems must be boolean`);
    if (
      raw.uniqueItems === true &&
      value.some((item, index) => value.slice(0, index).some((prior) => deepEqual(item, prior)))
    )
      errors.push(`${path}: array items are not unique`);
    const prefix =
      raw.prefixItems === undefined ? [] : schemas(raw.prefixItems, `${path}.prefixItems`);
    prefix.forEach((itemSchema, index) => {
      if (index < value.length)
        errors.push(...validate(value[index], itemSchema, `${path}[${String(index)}]`, root));
    });
    if (raw.items !== undefined) {
      const itemSchema = schema(raw.items, `${path}.items`);
      for (let index = prefix.length; index < value.length; index += 1)
        errors.push(...validate(value[index], itemSchema, `${path}[${String(index)}]`, root));
    }
    if (raw.contains !== undefined) {
      const contains = schema(raw.contains, `${path}.contains`);
      const count = value.filter(
        (item, index) => validate(item, contains, `${path}[${String(index)}]`, root).length === 0,
      ).length;
      const minContains = integerKeyword(raw.minContains, `${path}.minContains`) ?? 1;
      const maxContains = integerKeyword(raw.maxContains, `${path}.maxContains`);
      if (count < minContains || (maxContains !== undefined && count > maxContains))
        errors.push(`${path}: contains matched ${String(count)} items`);
    }
    if (raw.unevaluatedItems !== undefined) {
      const unevaluated = schema(raw.unevaluatedItems, `${path}.unevaluatedItems`);
      const evaluated = evaluatedItemIndexes(value, raw, root, false);
      for (let index = 0; index < value.length; index += 1)
        if (!evaluated.has(index))
          errors.push(...validate(value[index], unevaluated, `${path}[${String(index)}]`, root));
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).toSorted();
    const minProperties = integerKeyword(raw.minProperties, `${path}.minProperties`);
    const maxProperties = integerKeyword(raw.maxProperties, `${path}.maxProperties`);
    if (minProperties !== undefined && keys.length < minProperties)
      errors.push(`${path}: too few properties`);
    if (maxProperties !== undefined && keys.length > maxProperties)
      errors.push(`${path}: too many properties`);
    const required = raw.required ?? [];
    if (!Array.isArray(required) || required.some((key) => typeof key !== "string"))
      throw new SchemaDefinitionError(`${path}.required must be an array of strings`);
    for (const key of required)
      if (!((key as string) in object)) errors.push(`${path}.${key as string}: required`);
    const properties =
      raw.properties === undefined ? {} : record(raw.properties, `${path}.properties`);
    const compiledPatterns = patternEntries(raw.patternProperties, `${path}.patternProperties`);
    for (const key of keys) {
      const child = properties[key];
      if (child !== undefined)
        errors.push(
          ...validate(
            object[key],
            schema(child, `${path}.properties.${key}`),
            `${path}.${key}`,
            root,
          ),
        );
      const matching = compiledPatterns.filter(([pattern]) => pattern.test(key));
      for (const [, patternSchema] of matching)
        errors.push(...validate(object[key], patternSchema, `${path}.${key}`, root));
      if (child === undefined && matching.length === 0 && raw.additionalProperties !== undefined) {
        const additional = schema(raw.additionalProperties, `${path}.additionalProperties`);
        errors.push(...validate(object[key], additional, `${path}.${key}`, root));
      }
    }
    if (raw.dependentRequired !== undefined) {
      const dependencies = record(raw.dependentRequired, `${path}.dependentRequired`);
      for (const [key, dependency] of Object.entries(dependencies)) {
        if (!Array.isArray(dependency) || dependency.some((item) => typeof item !== "string"))
          throw new SchemaDefinitionError(`${path}.dependentRequired.${key} must be strings`);
        if (key in object)
          for (const requiredKey of dependency)
            if (!((requiredKey as string) in object))
              errors.push(`${path}.${requiredKey as string}: required by ${key}`);
      }
    }
    if (raw.dependentSchemas !== undefined) {
      const dependencies = record(raw.dependentSchemas, `${path}.dependentSchemas`);
      for (const [key, dependency] of Object.entries(dependencies))
        if (key in object)
          errors.push(
            ...validate(value, schema(dependency, `${path}.dependentSchemas.${key}`), path, root),
          );
    }
    if (raw.propertyNames !== undefined) {
      const propertySchema = schema(raw.propertyNames, `${path}.propertyNames`);
      for (const key of keys) errors.push(...validate(key, propertySchema, `${path}.${key}`, root));
    }
    if (raw.unevaluatedProperties !== undefined) {
      const unevaluated = schema(raw.unevaluatedProperties, `${path}.unevaluatedProperties`);
      const evaluated = evaluatedObjectKeys(object, raw, root, false);
      for (const key of keys)
        if (!evaluated.has(key))
          errors.push(...validate(object[key], unevaluated, `${path}.${key}`, root));
    }
  }
  return errors;
}

export function validateDraft202012(
  value: unknown,
  schemaObject: Readonly<Record<string, unknown>>,
): readonly string[] {
  const errors = validate(value, schemaObject, "$", schemaObject);
  return errors.toSorted().slice(0, 3);
}
