/** Turn a spec's multipart DESCRIPTOR into a real FormData.
 *
 *  A spec can say that a request is multipart and which fields it carries, but not
 *  what the bytes are — those come from a `FileAttachment` the caller holds. So the
 *  interpreter emits `{ name, kind: 'file' | 'value', value? }` and this fills in
 *  the one part it cannot: the file itself.
 *
 *  Kept out of `src/wire/` deliberately. The wire layer has no outbound imports and
 *  no notion of an attachment; this is the seam where spec data meets the caller's
 *  bytes, which makes it llm-layer glue rather than part of the interpreter.
 */

import type { MultipartField } from './../wire/interpreter';

export interface MultipartFile {
  /** The bytes, already read. */
  data: Uint8Array;
  filename: string;
  mimeType: string;
}

/** Build the FormData a multipart spec describes.
 *
 *  Field ORDER follows the spec, because multipart is an ordered format and some
 *  servers care. A `file` field with no file supplied is an error rather than an
 *  omission: a silently fileless upload would be accepted by the type checker and
 *  rejected by the provider, which is the exact failure mode the specs exist to
 *  remove. */
export function toFormData(fields: MultipartField[], file: MultipartFile): FormData {
  const form = new FormData();
  for (const f of fields) {
    if (f.kind === 'file') {
      form.append(f.name, new Blob([file.data as BlobPart], { type: file.mimeType }), file.filename);
    } else {
      form.append(f.name, String(f.value ?? ''));
    }
  }
  return form;
}
