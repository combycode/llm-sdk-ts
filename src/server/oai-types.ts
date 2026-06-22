/** OpenAI Chat Completions API types — request/response shapes we accept and emit.
 *
 *  V1 scope: the subset real clients (LM Studio, Open WebUI, the official
 *  openai npm package) actually send. Unused/rare fields are omitted. */

export type OaiRole = 'system' | 'user' | 'assistant' | 'tool';

export interface OaiContentPartText {
  type: 'text';
  text: string;
}

export interface OaiContentPartImageUrl {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
}

export type OaiContentPart = OaiContentPartText | OaiContentPartImageUrl;

export interface OaiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OaiChatMessage {
  role: OaiRole;
  /** OAI clients use either a string or an array of parts. V1 reads text parts,
   *  ignores others. `null` appears for assistant messages that are pure tool
   *  calls — we treat it as empty string. */
  content: string | OaiContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OaiToolCall[];
}

export interface OaiToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OaiChatRequest {
  model: string;
  messages: OaiChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  tools?: OaiToolDefinition[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  /** Arbitrary per-user identifier. */
  user?: string;
}

export type OaiFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;

export interface OaiChatChoice {
  index: number;
  message: OaiChatMessage;
  finish_reason: OaiFinishReason;
}

export interface OaiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OaiChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OaiChatChoice[];
  usage: OaiUsage;
}

export interface OaiChatStreamDelta {
  role?: OaiRole;
  content?: string;
  tool_calls?: OaiToolCall[];
}

export interface OaiChatStreamChoice {
  index: number;
  delta: OaiChatStreamDelta;
  finish_reason: OaiFinishReason;
}

export interface OaiChatStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OaiChatStreamChoice[];
}

export interface OaiModelEntry {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
}

export interface OaiModelsResponse {
  object: 'list';
  data: OaiModelEntry[];
}

export interface OaiErrorBody {
  error: {
    message: string;
    type: string;
    code?: string;
    param?: string;
  };
}
