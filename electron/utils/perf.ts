/**
 * Performance Benchmarking Utility
 *
 * Provides timing instrumentation for IPC handlers.
 * Enable via PERF_BENCHMARK=1 environment variable.
 */

const PERF_ENABLED = process.env.PERF_BENCHMARK === '1';
const SLOW_THRESHOLD_MS = 50;

interface TimingResult {
  name: string;
  durationMs: number;
  isSlow: boolean;
}

function formatDuration(ns: bigint): number {
  return Number(ns) / 1_000_000;
}

function logTiming(result: TimingResult): void {
  const status = result.isSlow ? '[SLOW]' : '[OK]';
  const color = result.isSlow ? '\x1b[31m' : '\x1b[32m';
  const reset = '\x1b[0m';

  console.log(
    `${color}[PERF]${reset} ${status} ${result.name}: ${result.durationMs.toFixed(2)}ms`
  );
}

export function measureSync<T>(name: string, fn: () => T): T {
  if (!PERF_ENABLED) {
    return fn();
  }

  const start = process.hrtime.bigint();
  try {
    return fn();
  } finally {
    const end = process.hrtime.bigint();
    const durationMs = formatDuration(end - start);
    logTiming({
      name,
      durationMs,
      isSlow: durationMs > SLOW_THRESHOLD_MS,
    });
  }
}

export async function measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!PERF_ENABLED) {
    return fn();
  }

  const start = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    const end = process.hrtime.bigint();
    const durationMs = formatDuration(end - start);
    logTiming({
      name,
      durationMs,
      isSlow: durationMs > SLOW_THRESHOLD_MS,
    });
  }
}

// NOTE(victor): Higher-order function to wrap IPC handlers without modifying their signatures
export function withTiming<TArgs extends any[], TReturn>(
  name: string,
  handler: (...args: TArgs) => Promise<TReturn>
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs): Promise<TReturn> => {
    return measureAsync(name, () => handler(...args));
  };
}

export function isPerfEnabled(): boolean {
  return PERF_ENABLED;
}
