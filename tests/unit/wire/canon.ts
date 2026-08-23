/** Make a captured request comparable to itself across runs.
 *
 *  Key order is not meaningful, `undefined` is not a value, and a `FormData` does
 *  not JSON-serialise in any stable way — depending on the runtime it comes out as
 *  `{}` or as its own enumerable properties, which once made a multipart upload
 *  compare unequal to itself across two runs of the same code.
 */

export const canon = (v: unknown): unknown => {
  if (typeof FormData !== 'undefined' && v instanceof FormData) {
    return canon({
      __formData: [...v.entries()].map(([name, x]) =>
        typeof x === 'string'
          ? { name, value: x }
          : { name, filename: (x as File).name, type: (x as File).type, size: (x as File).size },
      ),
    });
  }
  if (v instanceof Uint8Array) return { __bytes: v.length };
  // An AbortSignal is live plumbing, not part of the request's content.
  if (typeof AbortSignal !== 'undefined' && v instanceof AbortSignal) return '__signal';
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) if (src[k] !== undefined) out[k] = canon(src[k]);
    return out;
  }
  return v;
};

/** Canon, then through JSON, which is how a frozen fixture stores it. */
export const frozenForm = (v: unknown): unknown => JSON.parse(JSON.stringify(canon(v) ?? null));
