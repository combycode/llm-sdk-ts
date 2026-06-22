/** Tool ID parsing and version matching helpers.
 *  Format: "namespace:name@semver" (e.g. "orxa:summarize@1.0.0"). */

export interface ParsedToolId {
  namespace: string;
  name: string;
  version: string;
}

const ID_REGEX = /^([a-z0-9_-]+):([a-z0-9_-]+)@([0-9]+\.[0-9]+\.[0-9]+)$/;

export function parseToolId(id: string): ParsedToolId {
  const match = ID_REGEX.exec(id);
  if (!match) {
    throw new Error(`Invalid tool ID format: "${id}". Expected "namespace:name@major.minor.patch"`);
  }
  return {
    namespace: match[1],
    name: match[2],
    version: match[3],
  };
}

export function tryParseToolId(id: string): ParsedToolId | null {
  try {
    return parseToolId(id);
  } catch {
    return null;
  }
}

export function formatToolId(namespace: string, name: string, version: string): string {
  if (!/^[a-z0-9_-]+$/.test(namespace)) throw new Error(`Invalid namespace: "${namespace}"`);
  if (!/^[a-z0-9_-]+$/.test(name)) throw new Error(`Invalid tool name: "${name}"`);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version))
    throw new Error(`Invalid version: "${version}". Expected semver X.Y.Z`);
  return `${namespace}:${name}@${version}`;
}

export function matchesVersion(requested: string, actual: string): boolean {
  return requested === actual;
}

export function idWithoutVersion(id: string): string {
  const parsed = tryParseToolId(id);
  if (!parsed) return id;
  return `${parsed.namespace}:${parsed.name}`;
}
