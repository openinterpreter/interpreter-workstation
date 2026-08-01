import { execSync } from 'child_process';

interface KillPortProcessSyncOptions {
  platform?: NodeJS.Platform;
  exec?: (command: string, options?: { encoding?: 'utf8'; stdio?: 'ignore' | 'pipe' }) => string | Buffer;
  kill?: (pid: number) => void;
  breadcrumbContext?: string;
  addBreadcrumb?: (context: string, ports: number[]) => void;
  excludePids?: number[];
}

export function getCurrentProcessPortCleanupExclusions(
  processInfo: Pick<NodeJS.Process, 'pid' | 'ppid'> = process
): number[] {
  return [processInfo.pid, processInfo.ppid].filter((pid) => Number.isInteger(pid) && pid > 0);
}

// NOTE(victor): PID discovery still needs shell (lsof/netstat), but the actual kill
// uses process.kill (direct syscall) following VS Code's ptyService.ts pattern.
// Shelling out to `kill -9` fails in sandboxed contexts like bun test.
export function killPortProcessSync(ports: number | number[], options: KillPortProcessSyncOptions = {}): void {
  const portList = Array.isArray(ports) ? ports : [ports];
  const isWindows = (options.platform ?? process.platform) === 'win32';
  const run = options.exec ?? execSync;
  const killPid = options.kill ?? ((pid: number) => process.kill(pid, 'SIGKILL'));
  const excludedPids = new Set((options.excludePids ?? []).filter((pid) => Number.isInteger(pid) && pid > 0));
  if (options.breadcrumbContext && options.addBreadcrumb) {
    options.addBreadcrumb(options.breadcrumbContext, portList);
  }

  for (const port of portList) {
    try {
      if (isWindows) {
        const netstatOutput = String(run(`netstat -ano | findstr :${port}`, { encoding: 'utf8', stdio: 'pipe' }));
        const lines = netstatOutput.split('\n').filter(line => line.trim());
        const pids = new Set<number>();
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          const pidRaw = parts[parts.length - 1];
          const pid = Number(pidRaw);
          if (Number.isInteger(pid) && pid > 0) pids.add(pid);
        }
        for (const pid of pids) {
          if (excludedPids.has(pid)) {
            continue;
          }
          try {
            killPid(pid);
          } catch {}
        }
      } else {
        const pidOutput = String(run(`lsof -ti:${port}`, { encoding: 'utf8', stdio: 'pipe' })).trim();
        if (pidOutput) {
          for (const pidRaw of pidOutput.split('\n').filter(p => p)) {
            const pid = Number(pidRaw);
            if (!Number.isInteger(pid) || pid <= 0 || excludedPids.has(pid)) continue;
            try {
              killPid(pid);
            } catch {}
          }
        }
      }
    } catch {}
  }
}
