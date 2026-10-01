/** A single durable OIX conversation per Simple workspace. No shadow transcript. */
import { loadConfig, saveConfig, type AppConfig } from '../configStore';
import { getSimpleWorkspacePath } from '../simpleWorkspace';
import { hostSimpleProjects } from '../simpleInterfaceProjects';

export type SimplePrimaryThreadBinding = { threadId: string | null };

type Persistence = {
  workspace: () => Promise<string>;
  load: () => Promise<AppConfig>;
  save: (config: AppConfig) => Promise<void>;
};

const persistence: Persistence = {
  workspace: getSimpleWorkspacePath,
  load: loadConfig,
  save: saveConfig,
};

let pending: Promise<void> = Promise.resolve();

/** Serialize read-modify-write across windows in this process. */
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.then(() => undefined, () => undefined);
  return result;
}

function validateThreadId(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w-]{8,128}$/.test(value)) {
    throw new Error('Invalid primary conversation ID');
  }
  return value;
}

async function projectWorkspace(project?: { projectId: string; windowId: string }): Promise<string | null> {
  if (!project) return null;
  const active = await hostSimpleProjects(getSimpleWorkspacePath).active(project.windowId);
  if (!active || active.id !== project.projectId) throw new Error('Project is not open in this window');
  return active.path;
}

export async function getSimplePrimaryThread(
  deps: Persistence = persistence,
  project?: { projectId: string; windowId: string },
): Promise<SimplePrimaryThreadBinding> {
  const workspace = await projectWorkspace(project) ?? await deps.workspace();
  const config = await deps.load();
  return { threadId: config.simplePrimaryThreads?.[workspace] ?? null };
}

/** First claimant wins. A stale binding can be repaired only with an exact CAS. */
export async function bindSimplePrimaryThread(
  request: { threadId: string; expectedThreadId?: string | null; projectId?: string; windowId?: string },
  deps: Persistence = persistence,
): Promise<SimplePrimaryThreadBinding> {
  const threadId = validateThreadId(request?.threadId);
  if (request.expectedThreadId !== undefined && request.expectedThreadId !== null) {
    validateThreadId(request.expectedThreadId);
  }
  return serialize(async () => {
    if (Boolean(request.projectId) !== Boolean(request.windowId)) throw new Error('Project identity is incomplete');
    const workspace = await projectWorkspace(request.projectId && request.windowId
      ? { projectId: request.projectId, windowId: request.windowId } : undefined) ?? await deps.workspace();
    const config = await deps.load();
    const current = config.simplePrimaryThreads?.[workspace] ?? null;
    if (current === threadId) return { threadId };
    if (current !== (request.expectedThreadId ?? null)) {
      throw new Error('Primary conversation changed in another window; reload and retry.');
    }
    config.simplePrimaryThreads = { ...config.simplePrimaryThreads, [workspace]: threadId };
    await deps.save(config);
    return { threadId };
  });
}
