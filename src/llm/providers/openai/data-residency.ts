/** OpenAI data residency: a named region instead of a hand-written host.
 *
 *  OpenAI serves the same API from four hosts, and a project provisioned for one
 *  region must use that region's host. Getting it wrong is not a silent fallback --
 *  measured 2026-10-01 against `/v1/responses` with an unrestricted (global) project,
 *  `api.openai.com` answers 200 while the regional hosts refuse in the provider's own
 *  words: `us.` with `Attempted to access resource with incorrect regional hostname.
 *  Please make your request to api.openai.com`, `eu.` with `This endpoint is only
 *  accessible by projects with geography restrictions enabled.` Both replies name the
 *  host that was actually reached, which is what makes them proof the option routes.
 *  All four hostnames resolve, so the only question is which one a caller means.
 *
 *  Why a named region rather than leaving callers to set `baseURL`: a base URL is a
 *  string they have to get exactly right, including the scheme and the absence of a
 *  trailing path, and it silently disables every other default the adapter carries.
 *  A region is four spellings, checked at construction.
 *
 *  Mutually exclusive with `baseURL`, and that is an ERROR rather than a precedence
 *  rule. Either one alone is a clear instruction; together they are two different
 *  answers to "which host", and picking a winner would mean one of the two
 *  configurations a caller wrote is silently ignored. Upstream's client raises for
 *  the same reason. */

/** The regions OpenAI serves. `global` is the default host. */
export type OpenAIDataResidency = 'global' | 'us' | 'eu' | 'ae';

/** Region -> host. No `/v1`: the adapter's `completionPath()` supplies the path,
 *  and a base that already carried one would produce `/v1/v1/responses`. */
const HOSTS: Record<OpenAIDataResidency, string> = {
  global: 'https://api.openai.com',
  us: 'https://us.api.openai.com',
  eu: 'https://eu.api.openai.com',
  ae: 'https://ae.api.openai.com',
};

/** The base URL for a region, or `undefined` when none was asked for.
 *
 *  Throws when `baseURL` is also set, and when the region is not one of the four --
 *  a typo like `'EU'` would otherwise fall through to the default host and send
 *  EU-resident data to the global endpoint, which is the one failure this option
 *  exists to prevent. */
export function resolveDataResidency(
  residency: OpenAIDataResidency | undefined,
  baseURL: string | undefined,
): string | undefined {
  if (residency === undefined) return undefined;
  if (baseURL !== undefined) {
    throw new Error(
      'dataResidency and baseURL are mutually exclusive: both name the host to call, ' +
        'and honouring one would silently discard the other. Set the region, or set the URL.',
    );
  }
  const host = HOSTS[residency];
  if (!host) {
    throw new Error(
      `Invalid dataResidency ${JSON.stringify(residency)}; expected one of ` +
        `${Object.keys(HOSTS).map((r) => `'${r}'`).join(', ')}.`,
    );
  }
  return host;
}
