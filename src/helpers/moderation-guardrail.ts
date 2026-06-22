/** moderationGuardrail — built-in guardrail backed by the OpenAI moderations API.
 *
 *  Creates a Guardrail that calls moderate() on the last user message (input kind)
 *  or on the assistant response text (output kind). If the moderation result is
 *  flagged, the guardrail trips with severity 'high'.
 *
 *  Usage:
 *    const guard = moderationGuardrail({ apiKey: '...' });
 *    const agent = new AgentLoop({ client, guardrails: [guard] });
 *
 *  The moderation endpoint is free; a zero-cost entry is always emitted via the
 *  engine hook bus (see moderate.ts). Requires an OpenAI API key — fails clearly
 *  when invoked without one. */

import type { Guardrail, GuardrailDecision } from '../agent/guardrail-types';
import { moderate } from './moderate';
import type { ModerateOptions } from './moderate-types';
import { contentText } from '../llm/types/messages';

// ─── Constants ────────────────────────────────────────────────────────────────

const MODERATION_GUARDRAIL_SEVERITY = 'high' as const;
const MODERATION_INPUT_GUARDRAIL_NAME = 'moderation-input';
const MODERATION_OUTPUT_GUARDRAIL_NAME = 'moderation-output';

// ─── Options ──────────────────────────────────────────────────────────────────

export interface ModerationGuardrailOptions {
  /** OpenAI API key. Falls back to engine.apiKeys['openai'] when omitted. */
  apiKey?: string;
  /** Moderate the input (user messages). Default: true. */
  input?: boolean;
  /** Moderate the output (assistant responses). Default: false. */
  output?: boolean;
  /** Moderation model. Defaults to the moderate() helper default (omni-moderation-latest). */
  model?: string;
  /** Custom guardrail name prefix. Defaults to 'moderation'. */
  name?: string;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/** Build one or two Guardrail instances backed by the OpenAI moderations endpoint.
 *  Pass both into `guardrails` on AgentLoopConfig — one for input, one for output. */
export function moderationGuardrail(opts: ModerationGuardrailOptions = {}): Guardrail[] {
  const { apiKey, model, input: doInput = true, output: doOutput = false, name: prefix } = opts;
  const baseOpts: Pick<ModerateOptions, 'apiKey' | 'model'> = { apiKey, model };
  const result: Guardrail[] = [];

  if (doInput) {
    result.push(buildInputGuardrail(prefix ?? MODERATION_INPUT_GUARDRAIL_NAME, baseOpts));
  }
  if (doOutput) {
    result.push(buildOutputGuardrail(prefix ? `${prefix}-output` : MODERATION_OUTPUT_GUARDRAIL_NAME, baseOpts));
  }

  return result;
}

// ─── Internal builders ────────────────────────────────────────────────────────

function buildInputGuardrail(
  name: string,
  baseOpts: Pick<ModerateOptions, 'apiKey' | 'model'>,
): Guardrail {
  return {
    name,
    kind: 'input',
    async check(ctx): Promise<GuardrailDecision> {
      if (ctx.kind !== 'input') return { pass: true };
      // Moderate the last user message text (most recent content to check).
      const lastUser = [...ctx.messages].reverse().find((m) => m.role === 'user');
      if (!lastUser) return { pass: true };
      const text = typeof lastUser.content === 'string'
        ? lastUser.content
        : contentText(lastUser.content);
      if (!text) return { pass: true };

      const result = await moderate({ ...baseOpts, input: text });
      const flagged = Array.isArray(result) ? result.some((r) => r.flagged) : result.flagged;
      if (flagged) {
        return {
          pass: false,
          tripwire: true,
          reason: 'Input flagged by moderation',
          severity: MODERATION_GUARDRAIL_SEVERITY,
        };
      }
      return { pass: true };
    },
  };
}

function buildOutputGuardrail(
  name: string,
  baseOpts: Pick<ModerateOptions, 'apiKey' | 'model'>,
): Guardrail {
  return {
    name,
    kind: 'output',
    async check(ctx): Promise<GuardrailDecision> {
      if (ctx.kind !== 'output') return { pass: true };
      const text = ctx.response.text;
      if (!text) return { pass: true };

      const result = await moderate({ ...baseOpts, input: text });
      const flagged = Array.isArray(result) ? result.some((r) => r.flagged) : result.flagged;
      if (flagged) {
        return {
          pass: false,
          tripwire: true,
          reason: 'Output flagged by moderation',
          severity: MODERATION_GUARDRAIL_SEVERITY,
        };
      }
      return { pass: true };
    },
  };
}
