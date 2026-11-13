/** Content-free, owner-bound observation of a native OIX terminal. */
export type NativeTerminalStatusRequest = {
  threadId: string;
  turnId: string;
  itemId: string;
  nativeProcessId: string;
  terminalGeneration: number;
  maxWaitMs?: number;
};

export type NativeTerminalStatusResponse = {
  phase: 'running' | 'exited' | 'unknown';
  outputBytes: number;
  outputSha256: string | null;
  outputCapReached: boolean;
  exitCode: number | null;
  terminalGeneration: number | null;
  observationTimedOut: boolean;
};

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const opaque = /^[A-Za-z0-9_-]{1,160}$/;

export function validateNativeTerminalRequest(input: NativeTerminalStatusRequest): void {
  if (typeof input.threadId !== 'string' || !uuid.test(input.threadId) ||
      typeof input.turnId !== 'string' || !opaque.test(input.turnId) ||
      typeof input.itemId !== 'string' || !opaque.test(input.itemId) ||
      typeof input.nativeProcessId !== 'string' || !opaque.test(input.nativeProcessId) ||
      !Number.isSafeInteger(input.terminalGeneration) || input.terminalGeneration < 1 ||
      (input.maxWaitMs !== undefined && (!Number.isSafeInteger(input.maxWaitMs) ||
        input.maxWaitMs < 0 || input.maxWaitMs > 1000))) {
    throw new Error('Exact native terminal owner and bounded observation required.');
  }
}

export function boundNativeTerminalStatus(input: unknown, expectedGeneration: number): NativeTerminalStatusResponse {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Native terminal observation unavailable.');
  const value = input as Record<string, unknown>;
  if (!['running', 'exited', 'unknown'].includes(value.phase as string) ||
      !Number.isSafeInteger(value.outputBytes) || (value.outputBytes as number) < 0 ||
      typeof value.outputCapReached !== 'boolean' || typeof value.observationTimedOut !== 'boolean' ||
      (value.outputSha256 !== null && (typeof value.outputSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(value.outputSha256))) ||
      (value.exitCode !== null && (!Number.isSafeInteger(value.exitCode) ||
        (value.exitCode as number) < -2147483648 || (value.exitCode as number) > 2147483647)) ||
      (value.terminalGeneration !== null && (!Number.isSafeInteger(value.terminalGeneration) ||
        (value.terminalGeneration as number) < 1))) {
    throw new Error('Native terminal observation unavailable.');
  }
  if (value.phase === 'unknown' || value.terminalGeneration !== expectedGeneration) {
    return { phase: 'unknown', outputBytes: 0, outputSha256: null, outputCapReached: false,
      exitCode: null, terminalGeneration: null, observationTimedOut: false };
  }
  if (value.outputSha256 === null || (value.phase === 'running' && value.exitCode !== null) ||
      (value.phase === 'exited' && value.observationTimedOut)) {
    throw new Error('Native terminal observation unavailable.');
  }
  return { phase: value.phase as 'running' | 'exited', outputBytes: value.outputBytes as number,
    outputSha256: value.outputSha256 as string, outputCapReached: value.outputCapReached as boolean,
    exitCode: value.exitCode as number | null, terminalGeneration: value.terminalGeneration as number,
    observationTimedOut: value.observationTimedOut as boolean };
}
