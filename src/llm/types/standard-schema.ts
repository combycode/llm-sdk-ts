/** Standard Schema — the `~standard` protocol, as a protocol and not a dependency.
 *
 *  Every schema library in the ecosystem (Zod, Valibot, ArkType, Effect Schema,
 *  …) exposes the same hidden property, so a caller who already has a schema
 *  should not have to hand-write a second JSON Schema that says the same thing
 *  and then keep the two in step. Two descriptions of one shape drift, and the
 *  one the provider sees is the one nobody looks at.
 *
 *  The types below are declared structurally rather than imported from
 *  `@standard-schema/spec`. The spec package is types-only, but a dependency is
 *  a dependency: this library ships with none, and a protocol is exactly the
 *  kind of thing that does not need one — anything that satisfies the shape
 *  works, including a schema library that has not been written yet.
 *
 *  Two things a Standard Schema gives us that a JSON Schema cannot:
 *
 *   - **A real validator.** `~standard.validate` applies the schema's own
 *     semantics: refinements, branded types, cross-field checks — things JSON
 *     Schema has no vocabulary for and our zero-dep validator would never see.
 *   - **Transformation.** `validate` may return a value that is not the one it
 *     was given (coercions, defaults, renames). So the VALIDATED value is what
 *     a caller receives; returning the parsed one instead would hand back an
 *     object that looks right and skipped the schema's own work.
 *
 *  And one thing it cannot give us: the JSON Schema a provider needs on the
 *  wire. Converting an arbitrary schema library's AST is that library's job, and
 *  the spec has a conversion half (`~standard.jsonSchema`) for exactly this. A
 *  schema that offers no conversion is REFUSED rather than sent without a
 *  schema: a silently unconstrained request is the failure a caller is least
 *  likely to notice, because the model usually answers in roughly the right
 *  shape anyway.
 */

/** One reason a value failed. `path` locates it; a segment may be a key or a
 *  `{ key }` wrapper, because the spec allows both. */
export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardSchemaIssue> };

/** The validation half of the protocol — what every conforming library has. */
export interface StandardSchemaProps<Output = unknown> {
  readonly version: 1;
  readonly vendor: string;
  readonly validate: (
    value: unknown,
  ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
  // The spec's `types` carrier is deliberately NOT declared here. It exists for
  // type inference, nothing reads it at runtime, and this library does not infer
  // from it -- `structuredComplete<T>` takes its result type explicitly. A schema
  // that has it still satisfies this interface (extra properties are fine), so
  // omitting it costs a caller nothing and saves declaring public surface that
  // does nothing.
}

/** The conversion half. Optional in the ecosystem, required by us: without it
 *  there is nothing to put on the wire. */
export interface StandardJsonSchemaProps {
  readonly jsonSchema: {
    readonly input: (options?: { target?: string }) => Record<string, unknown>;
    readonly output: (options?: { target?: string }) => Record<string, unknown>;
  };
}

/** Any object carrying the marker, convertible or not. */
export interface StandardSchema<Output = unknown> {
  readonly '~standard': StandardSchemaProps<Output>;
}

/** A Standard Schema this library can actually use. */
export interface StandardSchemaWithJson<Output = unknown> {
  readonly '~standard': StandardSchemaProps<Output> & StandardJsonSchemaProps;
}

/** Wherever this library takes a schema, it takes either form.
 *
 *  The union is documentary: a `StandardSchema` is an object, so it already
 *  satisfied `Record<string, unknown>` and nothing downstream breaks. Spelling
 *  it out is what makes the second form discoverable, and what lets a reader of
 *  the type know the normalization below exists. */
export type SchemaSource = Record<string, unknown> | StandardSchema;

/** Does this object carry the marker at all?
 *
 *  Guarded, because the check reads a property off a value the caller supplied:
 *  a proxy or a getter that throws must not take down the request with a stack
 *  trace pointing at us. */
export function isStandardSchema(schema: unknown): schema is StandardSchema {
  try {
    return (
      (typeof schema === 'object' || typeof schema === 'function') &&
      schema !== null &&
      '~standard' in schema
    );
  } catch {
    return false;
  }
}

/** Does it carry the marker AND the conversion half? */
export function isStandardSchemaWithJson(schema: unknown): schema is StandardSchemaWithJson {
  if (!isStandardSchema(schema)) return false;
  try {
    const props = (schema as Partial<StandardSchemaWithJson>)['~standard'];
    return (
      props?.version === 1 &&
      typeof props.validate === 'function' &&
      typeof (props as StandardJsonSchemaProps).jsonSchema?.input === 'function' &&
      typeof (props as StandardJsonSchemaProps).jsonSchema?.output === 'function'
    );
  } catch {
    return false;
  }
}

/** The JSON Schema to send, from either form of schema.
 *
 *  `io` picks which side of the schema is meant: a tool's `parameters` and a
 *  structured-output schema describe what goes IN to the validator, which for a
 *  transforming schema is not the same document as what comes out.
 *
 *  A plain object passes through untouched — the overwhelmingly common case,
 *  and one this must not pay for. */
export function toJsonSchema(
  schema: SchemaSource,
  io: 'input' | 'output' = 'input',
): Record<string, unknown> {
  if (!isStandardSchema(schema)) return schema;
  if (!isStandardSchemaWithJson(schema)) {
    throw new Error(
      `Standard Schema from "${describeVendor(schema)}" cannot be converted to JSON Schema: ` +
        'it provides `~standard.validate` but no `~standard.jsonSchema`. Upgrade the schema ' +
        'library, use its Standard JSON Schema adapter, or pass a plain JSON Schema object. ' +
        '(Sending the request without a schema would leave the model unconstrained while you ' +
        'believed it was constrained, so this is refused rather than skipped.)',
    );
  }
  try {
    // `draft-2020-12` is what every provider's structured-output and tool
    // schemas are specified against, so it is asked for rather than left to the
    // library's default.
    return schema['~standard'].jsonSchema[io]({ target: 'draft-2020-12' });
  } catch (cause) {
    throw new Error(
      `Standard Schema from "${describeVendor(schema)}" failed to convert to JSON Schema: ` +
        (cause instanceof Error ? cause.message : String(cause)),
      { cause },
    );
  }
}

/** Validate a value through the schema's own semantics, returning what the
 *  schema produced.
 *
 *  Throws on failure, with every issue named and located — the caller's repair
 *  loop re-prompts with this message, so a vague one costs an extra round trip
 *  to the provider.
 *
 *  An async `validate` is refused rather than awaited. This runs inside a
 *  synchronous parse path, and a Promise is a truthy object with no `issues`
 *  property: awaited nowhere, it would have passed as a valid result and been
 *  returned to the caller in place of their data. */
export function validateStandardSchema<Output>(
  schema: StandardSchema<Output>,
  value: unknown,
): Output {
  const result = schema['~standard'].validate(value);
  if (isPromiseLike(result)) {
    // The validation still runs; swallow its rejection so an unhandled one does
    // not surface later, detached from the call that caused it.
    void Promise.resolve(result).catch(() => {});
    throw new Error(
      `Standard Schema from "${describeVendor(schema)}" validated asynchronously. ` +
        'Asynchronous validation is not supported here: schemas are applied while parsing a ' +
        'model response. Use the synchronous form of the schema.',
    );
  }
  if (result.issues) {
    throw new Error(result.issues.map(describeIssue).join('; '));
  }
  return result.value;
}

function describeIssue(issue: StandardSchemaIssue): string {
  const path = issue.path
    ?.map((segment) =>
      String(typeof segment === 'object' && segment !== null ? segment.key : segment),
    )
    .join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

/** The library's own name for itself, for an error a caller has to act on. A
 *  schema that does not say gets `unknown` rather than an empty quote. */
function describeVendor(schema: StandardSchema): string {
  try {
    return schema['~standard'].vendor || 'unknown';
  } catch {
    return 'unknown';
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
