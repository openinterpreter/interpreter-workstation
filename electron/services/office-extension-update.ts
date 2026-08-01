export interface UpdateSwapDeps {
  getStartupPromise: () => Promise<void> | null;
  hasServerProcess: () => boolean;
  isStarting: () => boolean;
  isServerRunning: () => Promise<boolean>;
  shutdown: () => Promise<void>;
  swap: () => Promise<void> | void;
  restart: () => Promise<void>;
  recoverFromSwapError?: (error: unknown, attempt: number, maxAttempts: number) => Promise<boolean> | boolean;
  maxSwapAttempts?: number;
}

export interface UpdateSwapResult {
  wasActive: boolean;
}

export async function performUpdateSwap(deps: UpdateSwapDeps): Promise<UpdateSwapResult> {
  const startupPromise = deps.getStartupPromise();
  if (startupPromise) {
    try {
      await startupPromise;
    } catch {}
  }

  const wasActive = deps.hasServerProcess()
    || !!deps.getStartupPromise()
    || deps.isStarting()
    || await deps.isServerRunning();

  if (wasActive) {
    await deps.shutdown();
  }

  const maxSwapAttempts = Math.max(1, deps.maxSwapAttempts ?? 1);
  for (let attempt = 1; attempt <= maxSwapAttempts; attempt += 1) {
    try {
      await deps.swap();
      break;
    } catch (error) {
      if (attempt >= maxSwapAttempts) {
        throw error;
      }

      const recovered = deps.recoverFromSwapError
        ? await deps.recoverFromSwapError(error, attempt, maxSwapAttempts)
        : false;

      if (!recovered) {
        throw error;
      }
    }
  }

  if (wasActive) {
    await deps.restart();
  }

  return { wasActive };
}
