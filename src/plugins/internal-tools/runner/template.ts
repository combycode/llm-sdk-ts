/** Template rendering — Mustache-style {{var}} substitution with dot-path support.
 *  Strict: throws on missing variables. No conditionals or loops. */

const VAR_REGEX = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;

function resolvePath(obj: unknown, path: string): unknown {
  const keys = path.split('.');
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(VAR_REGEX, (_, key: string) => {
    const value = resolvePath(vars, key);
    if (value === undefined) {
      throw new Error(`Template variable not found: "${key}"`);
    }
    return stringify(value);
  });
}

/**
 * Parse JSON from text, tolerating common LLM preambles/postscripts.
 * Handles markdown code fences, leading/trailing prose, extra whitespace.
 */
export function parseJsonWithFences(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json|JSON)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through */
  }

  const extracted = extractFirstJsonBlock(cleaned);
  if (extracted !== null) {
    return JSON.parse(extracted);
  }

  throw new SyntaxError(
    `parseJsonWithFences: no valid JSON in input (first 120 chars): ${cleaned.slice(0, 120)}`,
  );
}

function extractFirstJsonBlock(s: string): string | null {
  let start = -1;
  let openChar = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{' || s[i] === '[') {
      start = i;
      openChar = s[i];
      break;
    }
  }
  if (start < 0) return null;

  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < s.length; i++) {
    const c = s[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === openChar) depth++;
    else if (c === closeChar) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }

  return null;
}

export function formatNumberedList(items: readonly (string | number)[], startIndex = 1): string {
  return items.map((item, i) => `${i + startIndex}. ${item}`).join('\n');
}

export function formatBulletedList(items: readonly (string | number)[], bullet = '-'): string {
  return items.map((item) => `${bullet} ${item}`).join('\n');
}
