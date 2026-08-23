/** The upload part for a document: its bytes, and a name for them.
 *
 *  All three hosted backends upload a document the same way — the text as a
 *  `text/plain` file — and all three had their own copy of this, which is how they
 *  came to disagree about nothing yet still had to be fixed three times.
 *
 *  The fallback name is derived from the CONTENT. It used to be a random UUID,
 *  which made the request unreproducible: it could not be asserted in a test,
 *  frozen in a fixture, or matched against a log, and a retried upload arrived
 *  under a different name every time. A content hash keeps a retry idempotent
 *  while still separating two different documents.
 */

import type { MultipartFile } from '../../llm/wire-multipart';
import { fnv1a32Hex } from '../../util/hash';
import type { DocumentSource } from './types';

export function documentFile(source: DocumentSource): MultipartFile {
  return {
    data: new TextEncoder().encode(source.text),
    filename: source.label ?? `doc-${fnv1a32Hex(source.text)}.txt`,
    mimeType: 'text/plain',
  };
}
