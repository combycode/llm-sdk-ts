/** This library's version, as it identifies itself to a server.
 *
 *  A constant rather than an import of `package.json`, for two reasons. The
 *  manifest would be inlined into the browser bundle by the build, carrying the
 *  whole thing — dependency list, scripts, paths — into shipped output that has
 *  no use for any of it. And a `.json` import needs the assertion syntax in
 *  every consumer's toolchain, which is a compatibility cost for one string.
 *
 *  Kept in step by `tests/unit/version.test.ts`, which fails when this and
 *  `package.json` disagree. That guard is the point: the value it replaced was
 *  `'1.0.0'`, hard-coded in the MCP client and wrong for every release since —
 *  so every MCP server we ever spoke to was told the wrong client version, and
 *  nothing anywhere could notice.
 */
export const SDK_VERSION = '3.4.0';
