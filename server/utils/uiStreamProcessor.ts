/**
 * UI Message Stream Processor
 *
 * Processes AI SDK UI message streams to fix the "argsText can only be appended"
 * error from assistant-ui. This happens when JSON key ordering changes between
 * streamed deltas.
 *
 * Solution: Accumulate tool-input-delta events server-side and send them all
 * at once when tool-input-available arrives, with sorted keys.
 */

import type { Response } from 'express';
import { isTransientError, calculateBackoffDelay, sleep } from './retryUtils';
import { AUTH_SESSION_RE } from '../../src/lib/codex/errors';

/**
 * Recursively sort object keys alphabetically.
 * Used to normalize JSON serialization order for tool call arguments.
 */
export function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(sortObjectKeys);
  }

  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  for (const key of keys) {
    sorted[key] = sortObjectKeys((obj as Record<string, unknown>)[key]);
  }
  return sorted;
}

export interface UIStreamProcessorOptions {
  /**
   * Enable retry logic for transient read errors.
   * Should be true for external API calls (Anthropic, OpenAI, Groq),
   * false for internal endpoints where the underlying
   * process has already started and can't be retried.
   */
  enableRetry?: boolean;

  /**
   * Maximum number of retries for transient errors.
   * Only used if enableRetry is true.
   */
  maxRetries?: number;

  /**
   * Log prefix for debugging (e.g., '[Agent API]', '[Local Runtime]')
   */
  logPrefix?: string;

  /**
   * Callback when an error occurs. Return true to suppress the error
   * (e.g., if you've already handled it).
   */
  onError?: (error: any, chunkCount: number) => boolean | void;

  /**
   * Callback when the stream completes successfully.
   */
  onComplete?: (assistantResponseText: string, chunkCount: number) => void;

  /**
   * Get the last error message captured from the stream's onError callback.
   * Used to provide more context for finishReason: 'unknown' errors.
   */
  getLastError?: () => string | null;
}

export interface UIStreamProcessorResult {
  /**
   * The accumulated assistant response text.
   */
  assistantResponseText: string;

  /**
   * Number of chunks processed.
   */
  chunkCount: number;

  /**
   * Whether the stream completed successfully.
   */
  success: boolean;

  /**
   * Error if the stream failed.
   */
  error?: Error;
}

/**
 * Process a UI message stream from AI SDK, normalizing tool call argsText
 * to prevent the "argsText can only be appended" error from assistant-ui.
 *
 * This function:
 * 1. Reads chunks from the stream
 * 2. Accumulates tool-input-delta events server-side
 * 3. Sends accumulated deltas when tool-input-available arrives
 * 4. Sorts object keys for consistent JSON serialization
 * 5. Optionally retries on transient read errors
 * 6. Sends errors in AI SDK format on failure
 */
export async function processUIMessageStream(
  body: ReadableStream<Uint8Array>,
  res: Response,
  options: UIStreamProcessorOptions = {}
): Promise<UIStreamProcessorResult> {
  const {
    enableRetry = false,
    maxRetries = 3,
    logPrefix = '[UIStream]',
    onError,
    onComplete,
    getLastError,
  } = options;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // Track assistant's response text
  let assistantResponseText = '';

  // Track whether we've sent any meaningful data to the client
  // If we haven't, we can potentially retry on transient errors
  let hasSentData = false;
  let chunkCount = 0;

  // Track if we got an 'unknown' finish reason with no content (indicates API error)
  let finishReasonUnknown = false;

  // Track tool input deltas per tool call - we accumulate and send as single delta
  // This avoids the "argsText can only be appended" error from key reordering
  const toolInputAccumulators: Map<string, string> = new Map();

  // Retry state
  let streamRetryCount = 0;

  try {
    while (true) {
      let readResult: { done: boolean; value?: Uint8Array };

      try {
        readResult = await reader.read();
      } catch (readError: any) {
        // Handle read errors with retry for transient failures (if enabled)
        const errorCode = readError?.code || readError?.cause?.code || 'unknown';
        const isRetryableReadError = isTransientError(readError);
        const canRetryRead =
          enableRetry &&
          isRetryableReadError &&
          streamRetryCount < maxRetries &&
          !hasSentData;
        console.error(
          `${logPrefix} Stream read error (chunk ${chunkCount}, retry ${streamRetryCount}/${maxRetries}):`,
          {
            code: errorCode,
            message: readError?.message,
            retryable: isRetryableReadError,
            canRetryRead,
            hasSentData,
          }
        );

        if (canRetryRead) {
          // Transient error before sending data - we can retry
          const backoffDelay = calculateBackoffDelay(streamRetryCount, {
            maxRetries,
            baseDelayMs: 200,
            maxDelayMs: 5000,
            jitter: true,
          });
          console.log(`${logPrefix} Transient read error before data sent, retrying in ${backoffDelay}ms...`);
          streamRetryCount++;
          await sleep(backoffDelay);
          continue;
        }
        // Either permanent error, max retries, retry disabled, or already sent data - propagate
        throw readError;
      }

      const { done, value } = readResult;
      if (done) {
        console.log(`${logPrefix} Stream complete, sent ${chunkCount} chunks`);
        break;
      }

      chunkCount++;
      const text = decoder.decode(value, { stream: true });

      if (chunkCount <= 3 || chunkCount % 10 === 0) {
        console.log(`${logPrefix} chunk #${chunkCount}:`, text.substring(0, 200));
      }

      // Process each line for argsText normalization
      const lines = text.split('\n');
      for (const line of lines) {
        if (!line.trim()) {
          res.write('\n');
          continue;
        }

        // Parse SSE format: "data: {json}\n"
        const sseMatch = line.match(/^data:\s*(.*)$/);
        if (sseMatch) {
          const jsonStr = sseMatch[1];
          let outputLine = line;
          let skipLine = false;

          try {
            const data = JSON.parse(jsonStr);

            // Accumulate text-delta events
            if (data.type === 'text-delta' && data.delta) {
              assistantResponseText += data.delta;
              hasSentData = true; // We've sent meaningful content
            }

            // Accumulate tool-input-delta events server-side
            // We'll send them all at once when tool-input-available arrives
            // Note: AI SDK uses 'inputTextDelta' in SSE format, but 'delta' in raw events
            if (data.type === 'tool-input-delta') {
              const toolCallId = data.toolCallId;
              const current = toolInputAccumulators.get(toolCallId) || '';
              const deltaText = data.inputTextDelta || data.delta || '';
              toolInputAccumulators.set(toolCallId, current + deltaText);
              skipLine = true; // Don't send individual deltas
            }

            // When tool-input-available arrives, send the accumulated delta as a single chunk
            // This ensures argsText is built correctly on the client
            if (data.type === 'tool-input-available' && data.input !== undefined) {
              const toolCallId = data.toolCallId;
              const accumulatedArgsText = toolInputAccumulators.get(toolCallId) || '';

              console.log(`${logPrefix} tool-input-available:`, toolCallId, JSON.stringify(data.input));

              // DON'T send accumulated delta - the tool-input-available event has the complete input
              // Sending a delta event here breaks the stream parsing in assistant-ui
              // The client will use the 'input' field from tool-input-available directly

              // Then send tool-input-available with sorted keys
              data.input = sortObjectKeys(data.input);
              outputLine = `data: ${JSON.stringify(data)}`;

              // Clear accumulator
              toolInputAccumulators.delete(toolCallId);
            }

            // Also normalize tool-input-error
            if (data.type === 'tool-input-error' && data.input !== undefined) {
              data.input = sortObjectKeys(data.input);
              outputLine = `data: ${JSON.stringify(data)}`;
            }

            // Detect finishReason: 'unknown' which indicates API rejected the request
            // (often due to malformed messages like tool-calls with missing input)
            if (data.type === 'finish' && data.finishReason === 'unknown') {
              console.log(`${logPrefix} Detected finishReason: 'unknown' - API may have rejected request`);
              finishReasonUnknown = true;

              // If no content was sent, send error event INSTEAD of the finish event
              // This ensures the frontend receives the error and triggers onError callback
              if (!assistantResponseText.trim()) {
                console.error(`${logPrefix} Replacing finish event with error event (no content was sent)`);
                const lastError = getLastError?.();
                const errorMsg = lastError
                  || 'The AI provider did not return a response. This may indicate an issue with the message format or conversation length.';
                res.write(encoder.encode(`data: ${JSON.stringify({ type: 'error', errorText: errorMsg })}\n\n`));
                skipLine = true;
              }
            }
          } catch {
            // If parsing fails, just pass through
          }

          // Write (potentially modified) line to response
          if (!skipLine) {
            res.write(encoder.encode(outputLine + '\n'));
          }
        } else {
          // Non-SSE line, write as-is
          res.write(encoder.encode(line + '\n'));
        }
      }
    }

    // Note: Error handling for finishReason: 'unknown' is done inline when we detect the finish event
    // This ensures the error is sent BEFORE the finish event so the frontend receives it

    res.end();
    if (assistantResponseText) {
      console.log(`${logPrefix} Assistant response:`, assistantResponseText.substring(0, 500));
    }
    onComplete?.(assistantResponseText, chunkCount);

    return {
      assistantResponseText,
      chunkCount,
      success: !finishReasonUnknown || !!assistantResponseText.trim(),
    };
  } catch (streamError: any) {
    const errorCode = streamError?.code || streamError?.cause?.code || 'unknown';
    const isRetryable = isTransientError(streamError);
    const retryWasPossible = enableRetry && isRetryable && !hasSentData;
    const retryWasAttempted = streamRetryCount > 0;
    const shouldMarkRetryable = isRetryable && (retryWasPossible || retryWasAttempted);
    console.error(`${logPrefix} Stream error (code: ${errorCode}, retryable: ${isRetryable}, chunks sent: ${chunkCount}):`, streamError);
    if (isRetryable && enableRetry && hasSentData) {
      console.warn(`${logPrefix} Transient stream error occurred after data was sent; retry not possible at stream-read layer`);
    }

    // Let caller handle the error if they want
    if (onError?.(streamError, chunkCount) === true) {
      return {
        assistantResponseText,
        chunkCount,
        success: false,
        error: streamError,
      };
    }

    // Extract meaningful error message
    let errorMessage = 'An error occurred while generating the response.';
    if (streamError?.statusCode === 401) {
      const body = streamError?.responseBody ?? '';
      if (AUTH_SESSION_RE.test(body)) {
        errorMessage = 'Your session expired. Please sign in again.';
      } else {
        errorMessage = 'Authentication required. Please sign in to use hosted models.';
      }
    } else if (streamError?.responseBody) {
      try {
        const body = JSON.parse(streamError.responseBody);
        errorMessage = body?.error?.detail || body?.error?.message || body?.error || errorMessage;
      } catch {
        errorMessage = streamError.responseBody;
      }
    } else if (streamError?.message) {
      errorMessage = streamError.message;
    } else if (streamError?.data?.error) {
      const dataErr = streamError.data.error;
      errorMessage = typeof dataErr === 'string' ? dataErr : (dataErr?.message || errorMessage);
    } else if (streamError?.cause?.message) {
      errorMessage = streamError.cause.message;
    }

    // Send error using data stream protocol format (3:"message")
    // Send error using UI Message Stream format: { type: "error", errorText: string }
    const errorText = shouldMarkRetryable ? `[RETRYABLE] ${errorMessage} (code: ${errorCode})` : errorMessage;
    res.write(encoder.encode(`data: ${JSON.stringify({ type: 'error', errorText })}\n\n`));
    res.end();

    return {
      assistantResponseText,
      chunkCount,
      success: false,
      error: streamError instanceof Error ? streamError : new Error(String(streamError)),
    };
  }
}
