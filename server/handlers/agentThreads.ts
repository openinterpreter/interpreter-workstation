import { trashFile } from './files';
import { getCodexService, THREAD_LIST_DEFAULTS } from '../../src/lib/codex/service';
import type { v2 } from './codex-generated-types/index';

type ThreadListService = {
  listThreads(params?: v2.ThreadListParams): Promise<v2.ThreadListResponse>;
};

type TrashThreadService = {
  readThread(threadId: string): Promise<v2.Thread>;
  archiveThread(threadId: string): Promise<void>;
  unarchiveThread(threadId: string): Promise<void>;
};

type RenameThreadService = {
  setThreadName(threadId: string, name: string): Promise<void>;
};

type AgentThreadsService = ThreadListService & TrashThreadService & RenameThreadService;

type TrashThreadDependencies = {
  service?: AgentThreadsService;
  trashFileImpl?: typeof trashFile;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function listAllThreadIds(
  service: ThreadListService,
  params: v2.ThreadListParams,
): Promise<string[]> {
  const threadIds: string[] = [];
  let cursor: string | null = null;

  do {
    const response = await service.listThreads({
      ...params,
      ...(cursor ? { cursor } : {}),
    });
    threadIds.push(...response.data.map((thread) => thread.id));
    cursor = response.nextCursor;
  } while (cursor);

  return threadIds;
}

export async function listAllThreadIdsForDeletion(
  service: ThreadListService,
): Promise<string[]> {
  const [visibleThreadIds, hiddenThreadIds] = await Promise.all([
    listAllThreadIds(service, THREAD_LIST_DEFAULTS),
    listAllThreadIds(service, { ...THREAD_LIST_DEFAULTS, archived: true }),
  ]);

  return Array.from(new Set([...visibleThreadIds, ...hiddenThreadIds]));
}

export async function trashThread(
  threadId: string,
  dependencies: TrashThreadDependencies = {},
): Promise<void> {
  const service = dependencies.service ?? getCodexService();
  const trashFileImpl = dependencies.trashFileImpl ?? trashFile;
  const thread = await service.readThread(threadId);

  console.log(
    `[Agent Threads] Trashing thread threadId=${threadId} path=${thread.path ?? 'null'}`,
  );

  await service.archiveThread(threadId);
  try {
    const archivedThread = await service.readThread(threadId);
    if (!archivedThread.path) {
      return;
    }

    const result = await trashFileImpl(archivedThread.path);
    if (!result.success) {
      throw new Error(result.error ?? 'Failed to move thread to trash.');
    }
  } catch (error) {
    try {
      await service.unarchiveThread(threadId);
    } catch (rollbackError) {
      throw new Error(
        `Failed to move thread to trash: ${getErrorMessage(error)}. Rolling back the archived thread also failed: ${getErrorMessage(rollbackError)}.`,
      );
    }

    throw error;
  }
}

export async function deleteThread(
  threadId: string,
  dependencies: TrashThreadDependencies = {},
): Promise<{ success: true }> {
  await trashThread(threadId, dependencies);
  return { success: true };
}

export async function renameThread(
  threadId: string,
  name: string,
  dependencies: { service?: RenameThreadService } = {},
): Promise<{ success: true; name: string }> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error('Conversation name is required.');
  }

  const service = dependencies.service ?? getCodexService();
  await service.setThreadName(threadId, trimmedName);
  return { success: true, name: trimmedName };
}

export async function archiveThreadForHistory(
  threadId: string,
  dependencies: { service?: Pick<TrashThreadService, 'archiveThread'> } = {},
): Promise<{ success: true }> {
  const service = dependencies.service ?? getCodexService();
  await service.archiveThread(threadId);
  return { success: true };
}

export async function unarchiveThreadForHistory(
  threadId: string,
  dependencies: { service?: Pick<TrashThreadService, 'unarchiveThread'> } = {},
): Promise<{ success: true }> {
  const service = dependencies.service ?? getCodexService();
  await service.unarchiveThread(threadId);
  return { success: true };
}

export async function deleteAllThreads(
  dependencies: TrashThreadDependencies = {},
): Promise<{ success: true; trashedCount: number }> {
  const service = dependencies.service ?? getCodexService();
  const trashFileImpl = dependencies.trashFileImpl ?? trashFile;
  const threadIds = await listAllThreadIdsForDeletion(service);

  console.log(`[Agent Threads] Trashing all threads count=${threadIds.length}`);

  await Promise.all(
    threadIds.map((threadId) => trashThread(threadId, { service, trashFileImpl })),
  );

  return {
    success: true,
    trashedCount: threadIds.length,
  };
}
