/** defineTool — concise builder for AgentTool.
 *
 *  Reduces tool boilerplate. Instead of:
 *
 *    {
 *      definition: {
 *        name: 'word_count',
 *        description: 'Count words',
 *        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
 *      },
 *      execute: async (args) => String((args as {text:string}).text.split(/\s+/).length),
 *    }
 *
 *  write:
 *
 *    defineTool({
 *      name: 'word_count',
 *      description: 'Count words',
 *      params: { text: 'string' },
 *      execute: (args) => String(args.text.split(/\s+/).length),
 *    })
 *
 *  Type inference flows from `params` to the typed `args` parameter of
 *  `execute`. */

import type { AgentTool, ToolExecutionContext } from '../agent/types';
import type { ContentPart } from '../llm/types/messages';

/** Param spec — one of the JSON-schema scalars or an inline object. */
export type ParamSpec =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'string[]'
  | 'number[]'
  | {
      type: 'string' | 'number' | 'integer' | 'boolean';
      enum?: readonly string[];
      description?: string;
    }
  | {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
      description?: string;
    }
  | { type: 'array'; items: unknown; description?: string };

/** Map a ParamSpec → JSON schema fragment. */
function specToSchema(spec: ParamSpec): Record<string, unknown> {
  if (spec === 'string') return { type: 'string' };
  if (spec === 'number') return { type: 'number' };
  if (spec === 'integer') return { type: 'integer' };
  if (spec === 'boolean') return { type: 'boolean' };
  if (spec === 'string[]') return { type: 'array', items: { type: 'string' } };
  if (spec === 'number[]') return { type: 'array', items: { type: 'number' } };
  return spec as Record<string, unknown>;
}

/** Translate a ParamSpec to its TypeScript type, used to infer `args`. */
type InferParam<S> = S extends 'string'
  ? string
  : S extends 'number' | 'integer'
    ? number
    : S extends 'boolean'
      ? boolean
      : S extends 'string[]'
        ? string[]
        : S extends 'number[]'
          ? number[]
          : S extends { type: 'string'; enum: infer E }
            ? E extends readonly (infer U)[]
              ? U
              : string
            : S extends { type: 'string' }
              ? string
              : S extends { type: 'number' | 'integer' }
                ? number
                : S extends { type: 'boolean' }
                  ? boolean
                  : unknown;

type InferArgs<P extends Record<string, ParamSpec>> = {
  [K in keyof P]: InferParam<P[K]>;
};

export interface DefineToolInput<P extends Record<string, ParamSpec>> {
  name: string;
  description: string;
  /** Object spec — keys are arg names. All keys are treated as required by
   *  default; mark optional ones via `optional: ['x']`. */
  params: P;
  optional?: ReadonlyArray<keyof P & string>;
  execute: (
    args: InferArgs<P>,
    context: ToolExecutionContext,
  ) => Promise<string | ContentPart[]> | string | ContentPart[];
}

export function defineTool<P extends Record<string, ParamSpec>>(
  input: DefineToolInput<P>,
): AgentTool {
  const optional = new Set(input.optional ?? []);
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, spec] of Object.entries(input.params)) {
    properties[key] = specToSchema(spec);
    if (!optional.has(key)) required.push(key);
  }

  return {
    definition: {
      name: input.name,
      description: input.description,
      parameters: {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
    },
    execute: async (args, ctx) => input.execute(args as InferArgs<P>, ctx),
  };
}
