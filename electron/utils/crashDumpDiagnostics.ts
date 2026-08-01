import path from 'node:path';

const MAX_LOGGED_CRASH_DUMP_BASENAMES = 5;

export function formatTelemetrySettingState(value: boolean | null): 'enabled' | 'disabled' | 'unset' {
  if (value === null) {
    return 'unset';
  }

  return value ? 'enabled' : 'disabled';
}

export function listCrashDumpBasenamesForLog(dumpPaths: string[]): string {
  return dumpPaths
    .slice(0, MAX_LOGGED_CRASH_DUMP_BASENAMES)
    .map((dumpPath) => path.basename(dumpPath))
    .join(',');
}
