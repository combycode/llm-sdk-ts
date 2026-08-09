/** Types for `checkProvenance()` — detecting provider provenance signals in a file. */

import type { EngineHandle } from './engine';

/** Which provenance scheme a signal came from.
 *
 *  - `c2pa` — a signed Content Credentials manifest (who made it, with what, when).
 *  - `synthid` — Google's imperceptible watermark; survives some edits a manifest does not.
 *
 *  Open union (CONSTITUTION.md R1): more schemes will appear, and a new one must not break a
 *  consumer's `switch`. */
export type ProvenanceSignalKind = 'c2pa' | 'synthid' | (string & {});

/** How much a detected C2PA manifest can be believed. `trusted` is the only state that means the
 *  signature verified against a known issuer. Open by R1. */
export type ProvenanceValidationState =
  | 'trusted'
  | 'valid'
  | 'invalid'
  | 'not_present'
  | (string & {});

export interface ProvenanceSignal {
  kind: ProvenanceSignalKind;
  detected: boolean;
  validationState?: ProvenanceValidationState;
  /** Who signed the manifest (C2PA only). */
  issuer?: string;
  /** The model named in the manifest, when it records one. */
  model?: string;
  /** When the content was generated, per the manifest. */
  generatedAt?: string;
}

export interface ProvenanceCheckResult {
  /** Any signal detected at all.
   *
   *  **`false` is not proof a human made the file.** Provenance signals are strippable — a
   *  re-encode, a crop, or a screenshot usually removes them — so absence is absence of evidence,
   *  not evidence of absence. */
  detected: boolean;
  /** A signal was detected AND its manifest validated against a trusted issuer. This is the only
   *  positive statement the check supports. */
  trusted: boolean;
  /** Every signal reported, including the ones that came back `detected: false` — an image is
   *  checked for both C2PA and SynthID, audio for SynthID only. */
  signals: ProvenanceSignal[];
  createdAt?: number;
}

export interface CheckProvenanceOptions {
  /** File bytes to check. */
  file: Uint8Array;
  /** Filename with an extension — the API uses it to pick a decoder. */
  filename: string;
  /** MIME type of the file (e.g. `image/png`, `audio/wav`). */
  mimeType: string;
  provider?: string;
  apiKey?: string;
  engine?: EngineHandle;
}

/** The raw wire shape, normalised by `parseProvenanceResponse`. */
export interface ProvenanceRawResponse {
  object?: string;
  created_at?: number;
  results?: Array<{
    type?: string;
    outcome?: string;
    validation_state?: string;
    issuer?: string;
    model?: string;
    generated_at?: string;
  }>;
}
