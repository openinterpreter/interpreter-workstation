/**
 * Retry utilities with exponential backoff for network resilience
 */

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 5,
  baseDelayMs: 100,
  maxDelayMs: 30000,
  jitter: true,
};

/**
 * Transient errors that are safe to retry
 */
const TRANSIENT_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'EAI_AGAIN',
  // Undici stream/network errors
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

const TRANSIENT_ERROR_MESSAGES = [
  'terminated',
  'und_err_socket',
  'socket hang up',
  'network error',
  'fetch failed',
  'connection reset',
  'read ETIMEDOUT',
  'ETIMEDOUT',
];

/**
 * HTTP status codes that indicate transient failures
 */
const RETRYABLE_STATUS_CODES = new Set([
  408, // Request Timeout
  429, // Too Many Requests
  500, // Internal Server Error
  502, // Bad Gateway
  503, // Service Unavailable
  504, // Gateway Timeout
  520, // Cloudflare: Unknown Error
  521, // Cloudflare: Web Server Is Down
  522, // Cloudflare: Connection Timed Out
  523, // Cloudflare: Origin Is Unreachable
  524, // Cloudflare: A Timeout Occurred
]);

/**
 * Determines if an error is transient and safe to retry
 */
export function isTransientError(error: unknown): boolean {
  if (!error) return false;

  const err = error as any;
  const errorCode = typeof err.code === 'string' ? err.code.toUpperCase() : err.code;
  const causeCode = typeof err.cause?.code === 'string' ? err.cause.code.toUpperCase() : err.cause?.code;

  // Check error code (e.g., ETIMEDOUT, ECONNRESET)
  if (errorCode && TRANSIENT_ERROR_CODES.has(errorCode)) {
    return true;
  }

  // Check cause's error code
  if (causeCode && TRANSIENT_ERROR_CODES.has(causeCode)) {
    return true;
  }

  // Check for transient error messages
  const message = (err.message || '').toLowerCase();
  if (TRANSIENT_ERROR_MESSAGES.some(msg => message.includes(msg.toLowerCase()))) {
    return true;
  }

  // Check HTTP status codes
  const statusCode = err.statusCode || err.status || err.response?.status;
  if (statusCode && RETRYABLE_STATUS_CODES.has(statusCode)) {
    return true;
  }

  // Check for TypeError: terminated (common in fetch streams)
  if (err.name === 'TypeError' && message.includes('terminated')) {
    return true;
  }

  return false;
}

/**
 * Determines if an error should NOT be retried (permanent failures)
 */
export function isPermanentError(error: unknown): boolean {
  if (!error) return false;

  const err = error as any;
  const statusCode = err.statusCode || err.status || err.response?.status;

  // Auth errors - retrying won't help
  if (statusCode === 401 || statusCode === 403) {
    return true;
  }

  // Bad request - the request itself is invalid
  if (statusCode === 400) {
    return true;
  }

  // Not found - resource doesn't exist
  if (statusCode === 404) {
    return true;
  }

  // Payment required - retrying without resolving the billing condition is
  // pointless and is what user feedback iworkstation-issues#1266 explicitly
  // complained about: "when we run out of tokens, it does Error retrying
  // 1/5, 2/5... it really feels like an error. even though I just ran out
  // of free tokens. obviously display that immediately." We treat any 402
  // as a permanent error so the user sees the helpful "insufficient tokens"
  // message immediately instead of watching N retries pile up first.
  if (statusCode === 402) {
    return true;
  }

  // Check for auth-related messages
  const message = (err.message || '').toLowerCase();
  if (message.includes('authentication') || message.includes('unauthorized') || message.includes('forbidden')) {
    return true;
  }

  // Insufficient-tokens errors can also surface as wrapped messages
  // (Interpreter and provider proxies stringify the body into the error
  // message). Match the same patterns that NOT_ENOUGH_TOKENS_RE in
  // src/lib/codex/errors.ts surfaces a friendly message for, so we don't
  // retry behind that friendly message.
  if (
    message.includes('[not_enough_tokens]') ||
    message.includes('insufficient interpreter tokens')
  ) {
    return true;
  }

  return false;
}

/**
 * Calculate delay for next retry using exponential backoff with optional jitter
 */
export function calculateBackoffDelay(
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): number {
  // Exponential backoff: baseDelay * 2^attempt
  let delay = config.baseDelayMs * Math.pow(2, attempt);

  // Add jitter to prevent thundering herd (0.5x to 1.5x of calculated delay)
  if (config.jitter) {
    const jitterFactor = 0.5 + Math.random();
    delay = Math.floor(delay * jitterFactor);
  }

  // Cap at max delay
  return Math.min(delay, config.maxDelayMs);
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry and exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  context?: string
): Promise<T> {
  const fullConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= fullConfig.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // Don't retry permanent errors
      if (isPermanentError(error)) {
        console.error(`[Retry${context ? ` ${context}` : ''}] Permanent error, not retrying:`, error);
        throw error;
      }

      // Check if we should retry
      if (attempt < fullConfig.maxRetries && isTransientError(error)) {
        const delay = calculateBackoffDelay(attempt, fullConfig);
        console.log(
          `[Retry${context ? ` ${context}` : ''}] Transient error (attempt ${attempt + 1}/${fullConfig.maxRetries + 1}), ` +
          `retrying in ${delay}ms:`,
          (error as Error).message || error
        );
        await sleep(delay);
        continue;
      }

      // Not a transient error or max retries reached
      if (!isTransientError(error)) {
        console.error(`[Retry${context ? ` ${context}` : ''}] Non-transient error, not retrying:`, error);
      } else {
        console.error(`[Retry${context ? ` ${context}` : ''}] Max retries (${fullConfig.maxRetries}) exhausted`);
      }
      throw error;
    }
  }

  throw lastError || new Error('Retry failed with no error captured');
}

/**
 * Logs retry attempt information
 */
export function logRetryAttempt(
  context: string,
  attempt: number,
  maxRetries: number,
  error: unknown,
  nextDelayMs?: number
): void {
  const err = error as any;
  const errorInfo = {
    message: err?.message,
    code: err?.code || err?.cause?.code,
    statusCode: err?.statusCode || err?.status,
  };

  if (nextDelayMs !== undefined) {
    console.log(
      `[${context}] Retry attempt ${attempt + 1}/${maxRetries + 1} after ${nextDelayMs}ms delay:`,
      JSON.stringify(errorInfo)
    );
  } else {
    console.log(
      `[${context}] Attempt ${attempt + 1}/${maxRetries + 1} failed:`,
      JSON.stringify(errorInfo)
    );
  }
}
