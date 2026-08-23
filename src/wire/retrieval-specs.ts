/** The hosted-retrieval spec family: vector stores, file search stores, collections.
 *
 *  A sibling of `chat-specs.ts`, `media-specs.ts` and `service-specs.ts`, split for
 *  the same reason: the generated `registry.ts` imports all 118 specs, so anything
 *  reaching for it drags every family into the bundle. An application that never
 *  builds a corpus should not carry these.
 *
 *  Only leaves are buildable. The base specs exist to be inherited from — they
 *  carry auth and content-type and produce no endpoint of their own — so naming
 *  one is a mistake to catch, not a request to send.
 */

import { resolveSpec, type SpecDelta } from './inherit';
import type { WireSpec } from './interpreter';

// ── openai: vector stores ────────────────────────────────────────────────────
import openaiBase from './specs/retrieval/openai.base.json' with { type: 'json' };
import openaiJson from './specs/retrieval/openai.jsonBase.json' with { type: 'json' };
import openaiCreateCorpus from './specs/retrieval/openai.createCorpus.json' with { type: 'json' };
import openaiUploadFile from './specs/retrieval/openai.uploadFile.json' with { type: 'json' };
import openaiAttachDocument from './specs/retrieval/openai.attachDocument.json' with { type: 'json' };
import openaiIndexStatus from './specs/retrieval/openai.indexStatus.json' with { type: 'json' };
import openaiRemoveDocument from './specs/retrieval/openai.removeDocument.json' with { type: 'json' };
import openaiDeleteCorpus from './specs/retrieval/openai.deleteCorpus.json' with { type: 'json' };
import openaiListCorpora from './specs/retrieval/openai.listCorpora.json' with { type: 'json' };

// ── google: file search stores ───────────────────────────────────────────────
import googleBase from './specs/retrieval/google.base.json' with { type: 'json' };
import googleJson from './specs/retrieval/google.jsonBase.json' with { type: 'json' };
import googleCreateCorpus from './specs/retrieval/google.createCorpus.json' with { type: 'json' };
import googleUploadFile from './specs/retrieval/google.uploadFile.json' with { type: 'json' };
import googleImportFile from './specs/retrieval/google.importFile.json' with { type: 'json' };
import googlePollOperation from './specs/retrieval/google.pollOperation.json' with { type: 'json' };
import googleIndexStatus from './specs/retrieval/google.indexStatus.json' with { type: 'json' };
import googleRemoveDocument from './specs/retrieval/google.removeDocument.json' with { type: 'json' };
import googleDeleteCorpus from './specs/retrieval/google.deleteCorpus.json' with { type: 'json' };
import googleListCorpora from './specs/retrieval/google.listCorpora.json' with { type: 'json' };

// ── xai: grok collections ────────────────────────────────────────────────────
import xaiBase from './specs/retrieval/xai.base.json' with { type: 'json' };
import xaiManagement from './specs/retrieval/xai.management.json' with { type: 'json' };
import xaiStandard from './specs/retrieval/xai.standard.json' with { type: 'json' };
import xaiStandardJson from './specs/retrieval/xai.standardJson.json' with { type: 'json' };
import xaiCreateCorpus from './specs/retrieval/xai.createCorpus.json' with { type: 'json' };
import xaiUploadFile from './specs/retrieval/xai.uploadFile.json' with { type: 'json' };
import xaiAttachDocument from './specs/retrieval/xai.attachDocument.json' with { type: 'json' };
import xaiIndexStatus from './specs/retrieval/xai.indexStatus.json' with { type: 'json' };
import xaiRemoveDocument from './specs/retrieval/xai.removeDocument.json' with { type: 'json' };
import xaiDeleteCorpus from './specs/retrieval/xai.deleteCorpus.json' with { type: 'json' };
import xaiListCorpora from './specs/retrieval/xai.listCorpora.json' with { type: 'json' };
import xaiSearch from './specs/retrieval/xai.search.json' with { type: 'json' };

const RETRIEVAL_SPECS = new Map<string, SpecDelta>(
  (
    [
      openaiBase, openaiJson, openaiCreateCorpus, openaiUploadFile, openaiAttachDocument,
      openaiIndexStatus, openaiRemoveDocument, openaiDeleteCorpus, openaiListCorpora,
      googleBase, googleJson, googleCreateCorpus, googleUploadFile, googleImportFile,
      googlePollOperation, googleIndexStatus, googleRemoveDocument, googleDeleteCorpus,
      googleListCorpora,
      xaiBase, xaiManagement, xaiStandard, xaiStandardJson, xaiCreateCorpus, xaiUploadFile, xaiAttachDocument,
      xaiIndexStatus, xaiRemoveDocument, xaiDeleteCorpus, xaiListCorpora, xaiSearch,
    ] as unknown as SpecDelta[]
  ).map((s) => [(s as { id: string }).id, s]),
);

/** Specs that carry only auth/content-type for others to inherit. */
const ABSTRACT = new Set([
  'openai/retrieval.base',
  'openai/retrieval.json',
  'google/retrieval.base',
  'google/retrieval.json',
  'xai/retrieval.base',
  'xai/retrieval.management',
  'xai/retrieval.standard',
  'xai/retrieval.standardJson',
]);

const cache = new Map<string, WireSpec>();

/** Resolve a retrieval spec by id, flattening its `extends` chain. */
export function retrievalSpec(id: string): WireSpec {
  const hit = cache.get(id);
  if (hit) return hit;
  if (ABSTRACT.has(id)) throw new Error(`${id} is a base spec and builds no request`);
  const spec = resolveSpec(id, RETRIEVAL_SPECS) as WireSpec;
  cache.set(id, spec);
  return spec;
}
