type Listener = () => void;

let activeFilePath: string | null = null;
let listeners = new Set<Listener>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getActiveFilePathSnapshot(): string | null {
  return activeFilePath;
}

export function setActiveFilePathSnapshot(nextActiveFilePath: string | null): void {
  if (activeFilePath === nextActiveFilePath) {
    return;
  }

  activeFilePath = nextActiveFilePath;
  emitChange();
}

export function subscribeActiveFilePath(listener: Listener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function resetActiveFileStoreForTests(): void {
  activeFilePath = null;
  listeners = new Set<Listener>();
}
