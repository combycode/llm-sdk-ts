import { describe, expect, it } from 'bun:test';
import {
  BUILTIN_TOOLS,
  clarifyTool,
  classifyTool,
  registerBuiltinTools,
  scoreTool,
  structureTool,
  summarizeTool,
} from '../../../../src/plugins/internal-tools/builtin/builtin';
import { LocalBackend } from '../../../../src/plugins/internal-tools/backends/local';
import { getLLMToolDefinition } from '../../../../src/plugins/internal-tools/runner/define';
import { parseToolId } from '../../../../src/plugins/internal-tools/id';
import type { InternalTool } from '../../../../src/plugins/internal-tools/types';
import type { LLMClient } from '../../../../src/llm/client';
import type { CompletionResponse } from '../../../../src/llm/types/response';
import type { TokenCounter } from '../../../../src/agent/types';

// ─── doubles ───────────────────────────────────────────────────────────

interface CapturedCall {
  messages: Array<{ role: string; content: string }>;
  options: { system?: string; maxTokens?: number; temperature?: number };
}

type StubClient = LLMClient & { calls: CapturedCall[] };

function stubClient(reply = '{}'): StubClient {
  const calls: CapturedCall[] = [];
  const client = {
    calls,
    complete: async (
      messages: CapturedCall['messages'],
      options: CapturedCall['options'],
    ): Promise<CompletionResponse> => {
      calls.push({ messages, options });
      return {
        text: reply,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
        },
      } as unknown as CompletionResponse;
    },
    destroy: () => {},
  };
  return client as unknown as StubClient;
}

/** One token per 4 characters — enough to pin resolveMaxTokens arithmetic. */
const quarterCounter = {
  estimate: (text: string) => Math.ceil(text.length / 4),
  estimateMessage: () => 0,
  measure: async (text: string) => Math.ceil(text.length / 4),
  measureMessage: async () => 0,
  learn: () => {},
} as unknown as TokenCounter;

async function runTool(
  tool: InternalTool,
  input: unknown,
  opts: { modelId?: string; reply?: string } = {},
) {
  const client = stubClient(opts.reply ?? '{}');
  const output = await tool.execute(input, {
    client,
    modelId: opts.modelId ?? 'openai/gpt-5.4-nano',
    counter: quarterCounter,
  });
  return {
    output,
    call: client.calls[0] as CapturedCall,
    user: client.calls[0]?.messages[0]?.content ?? '',
  };
}

// ─── registration ──────────────────────────────────────────────────────

describe('BUILTIN_TOOLS', () => {
  it('ships exactly the five core tools, in a stable order', () => {
    expect(BUILTIN_TOOLS.map((t) => t.id)).toEqual([
      'orxa:summarize@1.0.0',
      'orxa:classify@1.0.0',
      'orxa:score@1.0.0',
      'orxa:structure@1.0.0',
      'orxa:clarify@1.0.0',
    ]);
  });

  it('exposes the same instances as the named exports', () => {
    expect(BUILTIN_TOOLS).toContain(summarizeTool);
    expect(BUILTIN_TOOLS).toContain(classifyTool);
    expect(BUILTIN_TOOLS).toContain(scoreTool);
    expect(BUILTIN_TOOLS).toContain(structureTool);
    expect(BUILTIN_TOOLS).toContain(clarifyTool);
  });

  it('every built-in carries a parseable id matching its namespace/name/version', () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(parseToolId(tool.id)).toEqual({
        namespace: tool.namespace,
        name: tool.name,
        version: tool.version,
      });
      expect(tool.namespace).toBe('orxa');
    }
  });

  it('every built-in declares an object input schema, tags and a model preference', () => {
    for (const tool of BUILTIN_TOOLS) {
      expect((tool.inputSchema as { type?: string }).type).toBe('object');
      expect(tool.tags?.length).toBeGreaterThan(0);
      expect(tool.modelPreference?.preferredModel).toBe('openai/gpt-5.4-nano');
      expect(tool.modelPreference?.fallbackModels).toEqual([
        'google/gemini-3.1-flash-lite-preview',
        'anthropic/claude-haiku-4-5',
      ]);
    }
  });

  it('every built-in asks for JSON output', () => {
    for (const tool of BUILTIN_TOOLS) {
      expect(getLLMToolDefinition(tool)?.outputFormat).toBe('json');
    }
  });
});

describe('registerBuiltinTools', () => {
  it('registers all five on the backend', async () => {
    const backend = new LocalBackend();
    registerBuiltinTools(backend);
    expect(backend.size).toBe(5);
    expect((await backend.list()).map((t) => t.id).sort()).toEqual(
      [...BUILTIN_TOOLS].map((t) => t.id).sort(),
    );
  });

  it('throws when called twice on the same backend', () => {
    const backend = new LocalBackend();
    registerBuiltinTools(backend);
    expect(() => registerBuiltinTools(backend)).toThrow(/already registered/);
  });

  it('leaves already-present unrelated tools alone', () => {
    const backend = new LocalBackend();
    backend.register({
      id: 'x:y@1.0.0',
      namespace: 'x',
      name: 'y',
      version: '1.0.0',
      description: '',
      inputSchema: { type: 'object' },
      execute: async () => null,
    });
    registerBuiltinTools(backend);
    expect(backend.size).toBe(6);
  });
});

// ─── summarize ─────────────────────────────────────────────────────────

describe('orxa:summarize — prompt preparation', () => {
  it('states a character limit when maxLength is given', async () => {
    const { user } = await runTool(summarizeTool, { content: 'C', maxLength: 200 });
    expect(user).toContain('Length target: keep the summary under 200 characters.');
  });

  it('states a token limit when only maxTokens is given', async () => {
    const { user } = await runTool(summarizeTool, { content: 'C', maxTokens: 150 });
    expect(user).toContain('Length target: keep the summary under 150 tokens.');
  });

  it('prefers maxLength over maxTokens in the length line', async () => {
    const { user } = await runTool(summarizeTool, {
      content: 'C',
      maxLength: 200,
      maxTokens: 150,
    });
    expect(user).toContain('under 200 characters');
    expect(user).not.toContain('tokens.');
  });

  it('falls back to a "concise" instruction when neither limit is given', async () => {
    const { user } = await runTool(summarizeTool, { content: 'C' });
    expect(user).toContain('Length target: concise (one or two sentences).');
  });

  it('treats maxLength=0 as "no limit"', async () => {
    const { user } = await runTool(summarizeTool, { content: 'C', maxLength: 0 });
    expect(user).toContain('Length target: concise');
  });

  it('renders a focus line when a focus is given', async () => {
    const { user } = await runTool(summarizeTool, { content: 'C', focus: 'security' });
    expect(user).toContain('Focus: security');
  });

  it('renders an empty focus line for the schema default (empty string)', async () => {
    const { user } = await runTool(summarizeTool, { content: 'C' });
    expect(user).not.toContain('Focus:');
  });

  it('embeds the content verbatim', async () => {
    const { user } = await runTool(summarizeTool, { content: 'Line one\nLine two' });
    expect(user).toContain('Content:\nLine one\nLine two');
  });
});

describe('orxa:summarize — resolveMaxTokens', () => {
  it('uses maxTokens verbatim when supplied', async () => {
    const { call } = await runTool(summarizeTool, { content: 'C', maxTokens: 321 });
    expect(call.options.maxTokens).toBe(321);
  });

  it('prefers maxTokens over maxLength', async () => {
    const { call } = await runTool(summarizeTool, {
      content: 'C',
      maxTokens: 321,
      maxLength: 4000,
    });
    expect(call.options.maxTokens).toBe(321);
  });

  it('derives a budget from maxLength: ceil(estimate * 1.6) + 400', async () => {
    // 400 chars at 4 chars/token = 100 tokens -> ceil(100 * 1.6) + 400 = 560
    const { call } = await runTool(summarizeTool, { content: 'C', maxLength: 400 });
    expect(call.options.maxTokens).toBe(560);
  });

  it('rounds the derived budget up', async () => {
    // 10 chars -> 3 tokens (ceil 2.5) -> ceil(4.8) + 400 = 405
    const { call } = await runTool(summarizeTool, { content: 'C', maxLength: 10 });
    expect(call.options.maxTokens).toBe(405);
  });

  it('falls back to 800 tokens when neither limit is given', async () => {
    const { call } = await runTool(summarizeTool, { content: 'C' });
    expect(call.options.maxTokens).toBe(800);
  });

  it('falls back to 800 for a non-positive limit', async () => {
    expect(
      (await runTool(summarizeTool, { content: 'C', maxTokens: 0 })).call.options.maxTokens,
    ).toBe(800);
    expect(
      (await runTool(summarizeTool, { content: 'C', maxLength: -5 })).call.options.maxTokens,
    ).toBe(800);
  });

  it('overrides the static modelPreference.maxTokens of 800', async () => {
    const { call } = await runTool(summarizeTool, { content: 'C', maxTokens: 42 });
    expect(summarizeTool.modelPreference?.maxTokens).toBe(800);
    expect(call.options.maxTokens).toBe(42);
  });
});

describe('orxa:summarize — provider variants', () => {
  it('uses the strict system prompt for anthropic', async () => {
    const { call } = await runTool(
      summarizeTool,
      { content: 'C' },
      { modelId: 'anthropic/claude-haiku-4-5' },
    );
    expect(call.options.system).toContain('You are a summarization tool.');
    expect(call.options.system).toContain('NEVER invent facts');
  });

  it('uses the strict system prompt for google', async () => {
    const { call } = await runTool(
      summarizeTool,
      { content: 'C' },
      { modelId: 'google/gemini-3.1-flash-lite-preview' },
    );
    expect(call.options.system).toContain('You are a summarization tool.');
  });

  it('uses the balanced system prompt for openai', async () => {
    const { call } = await runTool(summarizeTool, { content: 'C' });
    expect(call.options.system).toContain('You are a summarizer.');
    expect(call.options.system).toContain('HARD BINDING RULE');
  });

  it('appends the final-checks block only for the strict variant', async () => {
    const strict = await runTool(
      summarizeTool,
      { content: 'C' },
      { modelId: 'anthropic/claude-haiku-4-5' },
    );
    const balanced = await runTool(summarizeTool, { content: 'C' });
    expect(strict.user).toContain('Final checks before answering');
    expect(balanced.user).not.toContain('Final checks before answering');
  });

  it('carries the shared output example into both variants', async () => {
    for (const modelId of ['anthropic/claude-haiku-4-5', 'openai/gpt-5.4-nano']) {
      const { call } = await runTool(summarizeTool, { content: 'C' }, { modelId });
      expect(call.options.system).toContain('lithium-sulfur battery');
      expect(call.options.system).toContain('## Output example');
    }
  });

  it('parses the JSON reply into the declared output shape', async () => {
    const { output } = await runTool(
      summarizeTool,
      { content: 'C' },
      { reply: '{"summary":"s","keyPoints":["a","b"]}' },
    );
    expect(output).toEqual({ summary: 's', keyPoints: ['a', 'b'] });
  });

  it('recommends only models scoring 95 or better', () => {
    expect(summarizeTool.recommendedThreshold).toBe(95);
  });
});

// ─── classify ──────────────────────────────────────────────────────────

describe('orxa:classify', () => {
  it('renders the suggestions as a ZERO-based numbered list', async () => {
    const { user } = await runTool(classifyTool, {
      request: 'pick one',
      suggestions: ['alpha', 'beta', 'gamma'],
    });
    expect(user).toContain('0. alpha\n1. beta\n2. gamma');
  });

  it('quotes the request in the prompt', async () => {
    const { user } = await runTool(classifyTool, { request: 'pick one', suggestions: ['a'] });
    expect(user).toContain('Given the request: "pick one"');
  });

  it('renders an empty list when suggestions are missing', async () => {
    const { user } = await runTool(classifyTool, { request: 'r' });
    expect(user).toContain('Select the most relevant option from the following:\n\n');
  });

  it('runs at temperature 0 with a 300-token ceiling', async () => {
    const { call } = await runTool(classifyTool, { request: 'r', suggestions: ['a'] });
    expect(call.options.temperature).toBe(0);
    expect(call.options.maxTokens).toBe(300);
  });

  it('parses the classification result', async () => {
    const { output } = await runTool(
      classifyTool,
      { request: 'r', suggestions: ['a'] },
      { reply: '{"selectedIndex":0,"confidence":0.9,"reasoning":"why"}' },
    );
    expect(output).toEqual({ selectedIndex: 0, confidence: 0.9, reasoning: 'why' });
  });
});

// ─── score ─────────────────────────────────────────────────────────────

describe('orxa:score', () => {
  it('renders the criteria as a bulleted list', async () => {
    const { user } = await runTool(scoreTool, {
      task: 't',
      answer: 'a',
      criteria: ['accuracy', 'clarity'],
    });
    expect(user).toContain('- accuracy\n- clarity');
  });

  it('applies the schema default criteria when the caller supplies none', async () => {
    const { user } = await runTool(scoreTool, { task: 't', answer: 'a' });
    expect(user).toContain('- accuracy\n- completeness\n- clarity');
  });

  it('renders an empty criteria list when the caller passes an empty array', async () => {
    const { user } = await runTool(scoreTool, { task: 't', answer: 'a', criteria: [] });
    expect(user).toContain('Evaluation Criteria:\n\n');
  });

  it('embeds the task and answer', async () => {
    const { user } = await runTool(scoreTool, { task: 'THE TASK', answer: 'THE ANSWER' });
    expect(user).toContain('Task:\nTHE TASK');
    expect(user).toContain('Answer:\nTHE ANSWER');
  });

  it('allows a generous 2000-token budget for reasoning models', async () => {
    const { call } = await runTool(scoreTool, { task: 't', answer: 'a' });
    expect(call.options.maxTokens).toBe(2000);
    expect(call.options.temperature).toBe(0);
  });
});

// ─── structure ─────────────────────────────────────────────────────────

describe('orxa:structure', () => {
  it('pretty-prints the target schema into the prompt', async () => {
    const schema = { type: 'object', properties: { name: { type: 'string' } } };
    const { user } = await runTool(structureTool, { request: 'r', schema });
    expect(user).toContain(JSON.stringify(schema, null, 2));
  });

  it('embeds the raw request', async () => {
    const { user } = await runTool(structureTool, { request: 'my request', schema: {} });
    expect(user).toContain('Request: my request');
  });

  it('declares no output schema — the shape is caller-supplied', () => {
    expect(structureTool.outputSchema).toBeUndefined();
  });

  it('returns the parsed object as-is', async () => {
    const { output } = await runTool(
      structureTool,
      { request: 'r', schema: {} },
      { reply: '{"name":"Ada","age":36}' },
    );
    expect(output).toEqual({ name: 'Ada', age: 36 });
  });
});

// ─── clarify ───────────────────────────────────────────────────────────

describe('orxa:clarify', () => {
  it('renders the requirements as a bulleted list', async () => {
    const { user } = await runTool(clarifyTool, {
      prompt: 'p',
      requirements: ['must be short', 'must cite sources'],
    });
    expect(user).toContain('- must be short\n- must cite sources');
  });

  it('renders an empty list when requirements are missing', async () => {
    const { user } = await runTool(clarifyTool, { prompt: 'p' });
    expect(user).toContain('Requirements:\n\n');
  });

  it('embeds the prompt under test', async () => {
    const { user } = await runTool(clarifyTool, { prompt: 'THE PROMPT', requirements: ['r'] });
    expect(user).toContain('Prompt:\nTHE PROMPT');
  });

  it('instructs the model to be strict', async () => {
    const { call } = await runTool(clarifyTool, { prompt: 'p', requirements: ['r'] });
    expect(call.options.system).toContain('only mark satisfied=true if EVERY requirement');
    expect(call.options.temperature).toBe(0.2);
    expect(call.options.maxTokens).toBe(500);
  });

  it('parses the clarification result', async () => {
    const { output } = await runTool(
      clarifyTool,
      { prompt: 'p', requirements: ['r'] },
      { reply: '{"satisfied":false,"missingRequirements":["r"],"clarificationQuestions":["q?"]}' },
    );
    expect(output).toEqual({
      satisfied: false,
      missingRequirements: ['r'],
      clarificationQuestions: ['q?'],
    });
  });
});
