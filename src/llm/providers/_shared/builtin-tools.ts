/** Normalize a provider-native builtin-tool marker (output-item type, server-tool
 *  name, or result-block type) to the unified tool name used across the SDK
 *  (`web_search` | `code_interpreter` | …). Unknown values fall back to a stripped
 *  form so a new provider tool still yields a sensible name. */

const NATIVE_TO_UNIFIED: Record<string, string> = {
  // OpenAI / xAI Responses output-item types
  web_search_call: 'web_search',
  code_interpreter_call: 'code_interpreter',
  shell_call: 'shell',
  // A container-run shell reports its result in a SEPARATE item, which is the same
  // tool, not a second one. Without this entry the fallback strip leaves
  // `shell_call_output` (it ends in `_output`, not `_call`) and a caller sees a tool
  // they never enabled.
  shell_call_output: 'shell',
  // Anthropic server_tool_use names
  web_search: 'web_search',
  web_fetch: 'web_fetch',
  code_execution: 'code_interpreter',
  bash_code_execution: 'code_interpreter',
  // Anthropic *_tool_result block types
  web_search_tool_result: 'web_search',
  web_fetch_tool_result: 'web_fetch',
  code_execution_tool_result: 'code_interpreter',
  bash_code_execution_tool_result: 'code_interpreter',
};

export function unifiedBuiltinTool(native: string): string {
  return NATIVE_TO_UNIFIED[native] ?? native.replace(/_call$/, '').replace(/_tool_result$/, '');
}
