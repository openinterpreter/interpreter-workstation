type Listener = () => void;

let workspacePath: string | null = null;
let listeners = new Set<Listener>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getWorkspacePathSnapshot(): string | null {
  return workspacePath;
}

export function setWorkspacePathSnapshot(nextWorkspacePath: string | null): void {
  if (workspacePath === nextWorkspacePath) {
    return;
  }

  workspacePath = nextWorkspacePath;
  emitChange();
}

export function subscribeWorkspacePath(listener: Listener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

export function resetWorkspaceStoreForTests(): void {
  workspacePath = null;
  listeners = new Set<Listener>();
}
