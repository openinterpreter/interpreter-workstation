let defaultRuntimeLogFilePath: string | null = null;
let currentRuntimeLogFilePath: string | null = null;

export function initializeRuntimeLogFilePath(logFilePath: string): void {
  defaultRuntimeLogFilePath = logFilePath;
  currentRuntimeLogFilePath = logFilePath;
}

export function setCurrentRuntimeLogFilePath(logFilePath: string): void {
  currentRuntimeLogFilePath = logFilePath;
}

export function resetCurrentRuntimeLogFilePath(): void {
  currentRuntimeLogFilePath = defaultRuntimeLogFilePath;
}

export function getCurrentRuntimeLogFilePath(): string | null {
  return currentRuntimeLogFilePath;
}
