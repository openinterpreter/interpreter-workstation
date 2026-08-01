import type { ChildProcess } from 'child_process';

export function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let finished = false;

    const cleanup = () => {
      child.off('exit', onExit);
      clearTimeout(timeoutId);
    };

    const finish = (exited: boolean) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(exited);
    };

    const onExit = () => finish(true);
    const timeoutId = setTimeout(() => finish(false), timeoutMs);

    child.once('exit', onExit);

    if (child.exitCode !== null || child.signalCode !== null) {
      finish(true);
    }
  });
}

interface GracefulTerminateOptions {
  termTimeoutMs: number;
  killTimeoutMs: number;
  sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
}

interface GracefulTerminateResult {
  exitedAfterTerm: boolean;
  sentSigkill: boolean;
}

export async function gracefulTerminateChild(
  child: ChildProcess,
  options: GracefulTerminateOptions
): Promise<GracefulTerminateResult> {
  const sendSignal = options.sendSignal ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const exitedAfterTerm = await waitForChildExit(child, options.termTimeoutMs);
  if (exitedAfterTerm) {
    return { exitedAfterTerm: true, sentSigkill: false };
  }

  const pid = child.pid;
  if (!pid) {
    return { exitedAfterTerm: false, sentSigkill: false };
  }

  let sentSigkill = false;
  try {
    sendSignal(pid, 'SIGKILL');
    sentSigkill = true;
  } catch {
    sentSigkill = false;
  }

  await waitForChildExit(child, options.killTimeoutMs);
  return { exitedAfterTerm: false, sentSigkill };
}
