type ConsoleMethod = (...args: unknown[]) => void;
type ConsoleSink = 'stdout' | 'stderr';

export const BROKEN_CONSOLE_WRITE_ERROR =
  /\bwrite\s+(?:EPIPE|EIO)\b|\bEPIPE:\s*broken pipe\b|broken pipe|stream (?:is|was) destroyed/i;

const IGNORABLE_STDIO_ERROR_CODES = new Set([
  'EPIPE',
  'EIO',
  'EBADF',
  'ENOTCONN',
  'ERR_STREAM_DESTROYED',
]);

type GuardableConsoleStream = object & {
  on(event: 'error' | 'close', listener: (error?: unknown) => void): unknown;
};

let disabledConsoleMethods = new WeakSet<ConsoleMethod>();
let guardedConsoleStreams = new WeakSet<GuardableConsoleStream>();
const brokenConsoleSinks = new Set<ConsoleSink>();

function getErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const candidate = (error as { code?: unknown }).code;
  return typeof candidate === 'string' ? candidate : null;
}

function getErrorMessage(error: unknown): string | null {
  if (typeof error === 'string') {
    return error;
  }
  if (!error || typeof error !== 'object') {
    return null;
  }
  const candidate = (error as { message?: unknown }).message;
  return typeof candidate === 'string' ? candidate : null;
}

export function isIgnorableConsoleWriteError(error: unknown): boolean {
  const code = getErrorCode(error);
  if (code && IGNORABLE_STDIO_ERROR_CODES.has(code)) {
    return true;
  }

  const message = getErrorMessage(error);
  if (!message) {
    return false;
  }
  return BROKEN_CONSOLE_WRITE_ERROR.test(message);
}

function markConsoleSinkBroken(sink: ConsoleSink): void {
  brokenConsoleSinks.add(sink);
}

function attachConsoleSinkGuard(
  stream: GuardableConsoleStream | null | undefined,
  sink: ConsoleSink,
): void {
  if (!stream || guardedConsoleStreams.has(stream)) {
    return;
  }

  guardedConsoleStreams.add(stream);
  stream.on('error', () => {
    markConsoleSinkBroken(sink);
  });
  stream.on('close', () => {
    markConsoleSinkBroken(sink);
  });
}

export function attachConsoleSinkGuards(streams: {
  stdout?: GuardableConsoleStream | null;
  stderr?: GuardableConsoleStream | null;
}): void {
  attachConsoleSinkGuard(streams.stdout, 'stdout');
  attachConsoleSinkGuard(streams.stderr, 'stderr');
}

export function invokeConsoleSafely(
  method: ConsoleMethod,
  args: unknown[],
  sink?: ConsoleSink,
): boolean {
  if (sink && brokenConsoleSinks.has(sink)) {
    return false;
  }

  if (disabledConsoleMethods.has(method)) {
    return false;
  }

  try {
    method(...args);
    return true;
  } catch (error) {
    if (isIgnorableConsoleWriteError(error)) {
      disabledConsoleMethods.add(method);
      if (sink) {
        markConsoleSinkBroken(sink);
      }
      return false;
    }
    throw error;
  }
}

export function resetSafeConsoleWriteStateForTests(): void {
  disabledConsoleMethods = new WeakSet<ConsoleMethod>();
  guardedConsoleStreams = new WeakSet<GuardableConsoleStream>();
  brokenConsoleSinks.clear();
}
