export const DISK_SPACE_FULL_WARNING = 'disk-space-full' as const;

export type DiskSpaceFullWarning = typeof DISK_SPACE_FULL_WARNING;

export const ENOSPC_ERROR_PATTERN = /\bENOSPC:\s/i;

export function isDiskSpaceFullErrorMessage(message: string): boolean {
  return ENOSPC_ERROR_PATTERN.test(message);
}

export function isDiskSpaceFullError(error: unknown): boolean {
  if (error instanceof Error) {
    return isDiskSpaceFullErrorMessage(error.message);
  }
  return isDiskSpaceFullErrorMessage(String(error));
}
