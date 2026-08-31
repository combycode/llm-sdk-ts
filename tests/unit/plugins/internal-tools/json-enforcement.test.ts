import { describe, expect, it } from 'bun:test';
import {
  JSON_API_SYSTEM_PROMPT,
  composeJsonSystemPrompt,
} from '../../../../src/plugins/internal-tools/runner/json-enforcement';

describe('JSON_API_SYSTEM_PROMPT', () => {
  it('states the JSON-only contract the parser depends on', () => {
    expect(JSON_API_SYSTEM_PROMPT).toContain('Output ONLY valid JSON');
    expect(JSON_API_SYSTEM_PROMPT).toContain('JSON.parse()');
    expect(JSON_API_SYSTEM_PROMPT).toContain('RESPOND WITH RAW JSON ONLY');
  });

  it('names markdown fences as forbidden', () => {
    expect(JSON_API_SYSTEM_PROMPT).toContain('NO markdown');
    expect(JSON_API_SYSTEM_PROMPT).toContain('```json');
  });
});

describe('composeJsonSystemPrompt', () => {
  it('puts the JSON contract FIRST and the tool prompt after it', () => {
    const composed = composeJsonSystemPrompt('TOOL RULES HERE');
    expect(composed.startsWith(JSON_API_SYSTEM_PROMPT)).toBe(true);
    expect(composed.endsWith('TOOL RULES HERE')).toBe(true);
    expect(composed.indexOf('TOOL RULES HERE')).toBeGreaterThan(
      composed.indexOf('RESPOND WITH RAW JSON ONLY'),
    );
  });

  it('separates the two halves with exactly "\\n\\n---\\n\\n"', () => {
    expect(composeJsonSystemPrompt('X')).toBe(`${JSON_API_SYSTEM_PROMPT}\n\n---\n\nX`);
  });

  it('preserves an empty tool prompt as a trailing separator', () => {
    expect(composeJsonSystemPrompt('')).toBe(`${JSON_API_SYSTEM_PROMPT}\n\n---\n\n`);
  });
});
