/** Shared response helpers used across provider adapters. */

import type { FinishReason } from '../../types/response';

/**
 * Table-driven finish-reason mapper.
 * Returns 'tool_use' when tool calls are present; otherwise looks up the
 * provider's raw reason in reasonMap, falling back to 'stop'.
 */
export function extractFinishReason(
  hasToolCalls: boolean,
  providerReason: string | undefined,
  reasonMap: Record<string, FinishReason>,
): FinishReason {
  if (hasToolCalls) return 'tool_use';
  return (providerReason !== undefined ? reasonMap[providerReason] : undefined) ?? 'stop';
}
