/** Every wire spec the SDK ships, indexed by id.
 *
 *  A spec says HOW to talk to a provider API: field names, enum values, defaults,
 *  which shape a model version takes. It is deliberately DATA, so the same file
 *  is consumed by this SDK and by the Python and Rust ports, and a provider
 *  change is one reviewable diff rather than three code changes.
 *
 *  Generated index — regenerate rather than hand-edit when adding a spec.
 *
 *  Specs are not yet wired into the adapters: they currently serve as the
 *  differential oracle that proves the hand-written adapters and this data agree
 *  (see tests/unit/wire). Making them authoritative is the 3.0.0 step.
 */

import type { SpecDelta } from './inherit';

import spec_anthropic_batch_base from './specs/batch/anthropic.base.json';
import spec_anthropic_batch_cancel from './specs/batch/anthropic.cancel.json';
import spec_anthropic_batch_getResults from './specs/batch/anthropic.getResults.json';
import spec_anthropic_batch_getStatus from './specs/batch/anthropic.getStatus.json';
import spec_anthropic_batch_submit from './specs/batch/anthropic.submit.json';
import spec_anthropic_files_base from './specs/files/anthropic.base.json';
import spec_anthropic_files_delete from './specs/files/anthropic.delete.json';
import spec_anthropic_files_getInfo from './specs/files/anthropic.getInfo.json';
import spec_anthropic_files_list from './specs/files/anthropic.list.json';
import spec_anthropic_files_upload from './specs/files/anthropic.upload.json';
import spec_anthropic_messages_4_0 from './specs/anthropic-chain/messages@4.0.json';
import spec_anthropic_messages_4_1 from './specs/anthropic-chain/messages@4.1.json';
import spec_anthropic_messages_4_6 from './specs/anthropic-chain/messages@4.6.json';
import spec_anthropic_messages_4_7 from './specs/anthropic-chain/messages@4.7.json';
import spec_google_batch_cancel from './specs/batch/google.cancel.json';
import spec_google_batch_getResults from './specs/batch/google.getResults.json';
import spec_google_batch_getStatus from './specs/batch/google.getStatus.json';
import spec_google_batch_submit from './specs/batch/google.submit.json';
import spec_google_embeddings from './specs/embeddings/google.json';
import spec_google_files_delete from './specs/files/google.delete.json';
import spec_google_files_getInfo from './specs/files/google.getInfo.json';
import spec_google_files_list from './specs/files/google.list.json';
import spec_google_files_startUpload from './specs/files/google.startUpload.json';
import spec_google_gemini_image_edit_generateContent from './specs/google-media/gemini-image-edit.json';
import spec_google_gemini_image_generateContent from './specs/google-media/gemini-image.json';
import spec_google_gemini_tts_generateContent from './specs/google-media/gemini-tts.json';
import spec_google_generate_2_5 from './specs/google-chain/generate@2.5.json';
import spec_google_generate_3 from './specs/google-chain/generate@3.json';
import spec_google_imagen_predict from './specs/google-media/imagen.json';
import spec_google_interactions from './specs/google-interactions.json';
import spec_google_media_generateContent from './specs/google-media/generateContent.base.json';
import spec_google_media_predict from './specs/google-media/predict.base.json';
import spec_google_realtime from './specs/realtime/google.json';
import spec_google_veo_predictLongRunning from './specs/google-media/veo.json';
import spec_openai_audio_speech from './specs/openai-media/audio.speech.json';
import spec_openai_batch_base from './specs/batch/openai.base.json';
import spec_openai_batch_cancel from './specs/batch/openai.cancel.json';
import spec_openai_batch_getResults from './specs/batch/openai.getResults.json';
import spec_openai_batch_getStatus from './specs/batch/openai.getStatus.json';
import spec_openai_batch_uploadJsonl from './specs/batch/openai.uploadJsonl.json';
import spec_openai_chat_completions from './specs/openai-completions.json';
import spec_openai_embeddings from './specs/embeddings/openai.json';
import spec_openai_files_base from './specs/files/openai.base.json';
import spec_openai_files_delete from './specs/files/openai.delete.json';
import spec_openai_files_getInfo from './specs/files/openai.getInfo.json';
import spec_openai_files_list from './specs/files/openai.list.json';
import spec_openai_files_upload from './specs/files/openai.upload.json';
import spec_openai_images_edits from './specs/openai-media/images.edits.json';
import spec_openai_images_generations from './specs/openai-media/images.generations.json';
import spec_openai_images_generations_dall_e from './specs/openai-media/images.generations.dalle.json';
import spec_openai_media_base from './specs/openai-media/media.base.json';
import spec_openai_media_images from './specs/openai-media/images.base.json';
import spec_openai_realtime from './specs/realtime/openai.json';
import spec_openai_responses from './specs/openai-responses.json';
import spec_openai_videos from './specs/openai-media/videos.json';
import spec_openrouter_embeddings from './specs/embeddings/openrouter.json';
import spec_openrouter_media_audio from './specs/openrouter-media/audio.json';
import spec_openrouter_media_base from './specs/openrouter-media/base.json';
import spec_openrouter_media_image from './specs/openrouter-media/image.json';
import spec_openrouter_media_imageEdit from './specs/openrouter-media/image.edit.json';
import spec_xai_batch_addRequests from './specs/batch/xai.addRequests.json';
import spec_xai_batch_base from './specs/batch/xai.base.json';
import spec_xai_batch_create from './specs/batch/xai.create.json';
import spec_xai_batch_getResults from './specs/batch/xai.getResults.json';
import spec_xai_batch_getStatus from './specs/batch/xai.getStatus.json';
import spec_xai_files_upload from './specs/files/xai.upload.json';
import spec_xai_images_base from './specs/xai-media/images.base.json';
import spec_xai_images_edits from './specs/xai-media/images.edits.json';
import spec_xai_images_generations from './specs/xai-media/images.generations.json';
import spec_xai_media_base from './specs/xai-media/base.json';
import spec_xai_tts from './specs/xai-media/tts.json';
import spec_xai_videos_edits from './specs/xai-media/videos.edits.json';
import spec_xai_videos_extensions from './specs/xai-media/videos.extensions.json';
import spec_xai_videos_generations from './specs/xai-media/videos.generations.json';

/** All shipped specs, keyed by `provider/api@version` id. */
export const WIRE_SPECS: ReadonlyMap<string, SpecDelta> = new Map<string, SpecDelta>([
  ['anthropic/batch.base', spec_anthropic_batch_base as unknown as SpecDelta],
  ['anthropic/batch.cancel', spec_anthropic_batch_cancel as unknown as SpecDelta],
  ['anthropic/batch.getResults', spec_anthropic_batch_getResults as unknown as SpecDelta],
  ['anthropic/batch.getStatus', spec_anthropic_batch_getStatus as unknown as SpecDelta],
  ['anthropic/batch.submit', spec_anthropic_batch_submit as unknown as SpecDelta],
  ['anthropic/files.base', spec_anthropic_files_base as unknown as SpecDelta],
  ['anthropic/files.delete', spec_anthropic_files_delete as unknown as SpecDelta],
  ['anthropic/files.getInfo', spec_anthropic_files_getInfo as unknown as SpecDelta],
  ['anthropic/files.list', spec_anthropic_files_list as unknown as SpecDelta],
  ['anthropic/files.upload', spec_anthropic_files_upload as unknown as SpecDelta],
  ['anthropic/messages@4.0', spec_anthropic_messages_4_0 as unknown as SpecDelta],
  ['anthropic/messages@4.1', spec_anthropic_messages_4_1 as unknown as SpecDelta],
  ['anthropic/messages@4.6', spec_anthropic_messages_4_6 as unknown as SpecDelta],
  ['anthropic/messages@4.7', spec_anthropic_messages_4_7 as unknown as SpecDelta],
  ['google/batch.cancel', spec_google_batch_cancel as unknown as SpecDelta],
  ['google/batch.getResults', spec_google_batch_getResults as unknown as SpecDelta],
  ['google/batch.getStatus', spec_google_batch_getStatus as unknown as SpecDelta],
  ['google/batch.submit', spec_google_batch_submit as unknown as SpecDelta],
  ['google/embeddings', spec_google_embeddings as unknown as SpecDelta],
  ['google/files.delete', spec_google_files_delete as unknown as SpecDelta],
  ['google/files.getInfo', spec_google_files_getInfo as unknown as SpecDelta],
  ['google/files.list', spec_google_files_list as unknown as SpecDelta],
  ['google/files.startUpload', spec_google_files_startUpload as unknown as SpecDelta],
  ['google/gemini-image-edit@generateContent', spec_google_gemini_image_edit_generateContent as unknown as SpecDelta],
  ['google/gemini-image@generateContent', spec_google_gemini_image_generateContent as unknown as SpecDelta],
  ['google/gemini-tts@generateContent', spec_google_gemini_tts_generateContent as unknown as SpecDelta],
  ['google/generate@2.5', spec_google_generate_2_5 as unknown as SpecDelta],
  ['google/generate@3', spec_google_generate_3 as unknown as SpecDelta],
  ['google/imagen@predict', spec_google_imagen_predict as unknown as SpecDelta],
  ['google/interactions', spec_google_interactions as unknown as SpecDelta],
  ['google/media.generateContent', spec_google_media_generateContent as unknown as SpecDelta],
  ['google/media.predict', spec_google_media_predict as unknown as SpecDelta],
  ['google/realtime', spec_google_realtime as unknown as SpecDelta],
  ['google/veo@predictLongRunning', spec_google_veo_predictLongRunning as unknown as SpecDelta],
  ['openai/audio.speech', spec_openai_audio_speech as unknown as SpecDelta],
  ['openai/batch.base', spec_openai_batch_base as unknown as SpecDelta],
  ['openai/batch.cancel', spec_openai_batch_cancel as unknown as SpecDelta],
  ['openai/batch.getResults', spec_openai_batch_getResults as unknown as SpecDelta],
  ['openai/batch.getStatus', spec_openai_batch_getStatus as unknown as SpecDelta],
  ['openai/batch.uploadJsonl', spec_openai_batch_uploadJsonl as unknown as SpecDelta],
  ['openai/chat-completions', spec_openai_chat_completions as unknown as SpecDelta],
  ['openai/embeddings', spec_openai_embeddings as unknown as SpecDelta],
  ['openai/files.base', spec_openai_files_base as unknown as SpecDelta],
  ['openai/files.delete', spec_openai_files_delete as unknown as SpecDelta],
  ['openai/files.getInfo', spec_openai_files_getInfo as unknown as SpecDelta],
  ['openai/files.list', spec_openai_files_list as unknown as SpecDelta],
  ['openai/files.upload', spec_openai_files_upload as unknown as SpecDelta],
  ['openai/images.edits', spec_openai_images_edits as unknown as SpecDelta],
  ['openai/images.generations', spec_openai_images_generations as unknown as SpecDelta],
  ['openai/images.generations@dall-e', spec_openai_images_generations_dall_e as unknown as SpecDelta],
  ['openai/media.base', spec_openai_media_base as unknown as SpecDelta],
  ['openai/media.images', spec_openai_media_images as unknown as SpecDelta],
  ['openai/realtime', spec_openai_realtime as unknown as SpecDelta],
  ['openai/responses', spec_openai_responses as unknown as SpecDelta],
  ['openai/videos', spec_openai_videos as unknown as SpecDelta],
  ['openrouter/embeddings', spec_openrouter_embeddings as unknown as SpecDelta],
  ['openrouter/media.audio', spec_openrouter_media_audio as unknown as SpecDelta],
  ['openrouter/media.base', spec_openrouter_media_base as unknown as SpecDelta],
  ['openrouter/media.image', spec_openrouter_media_image as unknown as SpecDelta],
  ['openrouter/media.imageEdit', spec_openrouter_media_imageEdit as unknown as SpecDelta],
  ['xai/batch.addRequests', spec_xai_batch_addRequests as unknown as SpecDelta],
  ['xai/batch.base', spec_xai_batch_base as unknown as SpecDelta],
  ['xai/batch.create', spec_xai_batch_create as unknown as SpecDelta],
  ['xai/batch.getResults', spec_xai_batch_getResults as unknown as SpecDelta],
  ['xai/batch.getStatus', spec_xai_batch_getStatus as unknown as SpecDelta],
  ['xai/files.upload', spec_xai_files_upload as unknown as SpecDelta],
  ['xai/images.base', spec_xai_images_base as unknown as SpecDelta],
  ['xai/images.edits', spec_xai_images_edits as unknown as SpecDelta],
  ['xai/images.generations', spec_xai_images_generations as unknown as SpecDelta],
  ['xai/media.base', spec_xai_media_base as unknown as SpecDelta],
  ['xai/tts', spec_xai_tts as unknown as SpecDelta],
  ['xai/videos.edits', spec_xai_videos_edits as unknown as SpecDelta],
  ['xai/videos.extensions', spec_xai_videos_extensions as unknown as SpecDelta],
  ['xai/videos.generations', spec_xai_videos_generations as unknown as SpecDelta],
]);

/** Resolve a spec id to its flattened form, walking `extends`. */
export function getWireSpec(id: string): SpecDelta {
  const spec = WIRE_SPECS.get(id);
  if (!spec) throw new Error(`unknown wire spec: ${id}`);
  return spec;
}
