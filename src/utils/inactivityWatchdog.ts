export interface InactivityWatchdog {
  poke(): void;
  clear(): void;
}

export function createInactivityWatchdog(
  timeoutMs: number,
  onTimeout: () => void,
): InactivityWatchdog {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timeoutId === null) {
      return;
    }
    clearTimeout(timeoutId);
    timeoutId = null;
  };

  const poke = () => {
    clear();
    timeoutId = setTimeout(() => {
      timeoutId = null;
      onTimeout();
    }, timeoutMs);
  };

  return { poke, clear };
}
