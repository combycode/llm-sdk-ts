/** Minimal glob → regex compiler for permission target matching. */

const REGEX_META = /[.+()|[\]{}^$\\]/;

export interface GlobOptions {
  loose?: boolean;
}

export function globToRegex(pattern: string, options: GlobOptions = {}): RegExp {
  const loose = options.loose === true;
  let out = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 2;
        if (pattern[i] === '/') i++;
      } else if (loose) {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      out += loose ? '.' : '[^/]';
      i++;
    } else if (REGEX_META.test(c)) {
      out += `\\${c}`;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  out += '$';
  return new RegExp(out);
}

export function compileGlobs(
  patterns: readonly string[],
  options: GlobOptions = {},
): (s: string) => boolean {
  const regexes = patterns.map((p) => globToRegex(p, options));
  return (s: string) => regexes.some((r) => r.test(s));
}
