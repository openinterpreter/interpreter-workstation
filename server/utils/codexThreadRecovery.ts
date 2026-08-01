import type { v2 } from '../handlers/codex-generated-types/index';
import { JSONRPCErrorCode, JSONRPCErrorException, type JSONRPCError } from 'json-rpc-2.0';

const ARRAY_ABOVE_MAX_LENGTH_CODE = 'array_above_max_length';
const THREAD_UNAVAILABLE_ERROR_MARKERS = [
  'thread not found',
  'thread not loaded',
  'invalid thread id',
] as const;

export function requiresFreshThread(thread: v2.Thread): boolean {
  const lastTurn = thread.turns[thread.turns.length - 1];
  return lastTurn?.status === 'failed'
    && lastTurn.error?.message?.includes(ARRAY_ABOVE_MAX_LENGTH_CODE) === true;
}

type JsonRpcErrorShape = Pick<JSONRPCError, 'code' | 'message'>;

function isJsonRpcErrorShape(value: unknown): value is JsonRpcErrorShape {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.code === 'number' && typeof candidate.message === 'string';
}

function toJsonRpcErrorShape(error: unknown): JsonRpcErrorShape | null {
  if (error instanceof JSONRPCErrorException) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  if (isJsonRpcErrorShape(error)) {
    return error;
  }

  return null;
}

export function isThreadUnavailableError(error: unknown): boolean {
  const jsonRpcError = toJsonRpcErrorShape(error);
  if (!jsonRpcError) {
    return false;
  }

  if (jsonRpcError.code !== JSONRPCErrorCode.InvalidRequest) {
    return false;
  }

  const normalized = jsonRpcError.message.toLowerCase();
  return THREAD_UNAVAILABLE_ERROR_MARKERS.some((marker) => normalized.startsWith(marker));
}
