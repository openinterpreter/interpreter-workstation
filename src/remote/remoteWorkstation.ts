import type { FileThumbnailData } from '../../shared/types/fileThumbnail';
import type { LayoutState } from '../../shared/types/layout';
import type { AgentModelConfig } from '../../shared/types/model';
import type {
  PublicWorkspaceEntry,
  PublicWorkspaceListing,
} from '../../shared/types/publicWorkspace';
import {
  getBrowserWorkstationConnection,
  isPublicWorkstationPublication,
} from './workstationConnection';

// Remote paths live in a stable virtual namespace. The browser never receives
// the connected computer's absolute publication path.
export const REMOTE_WORKSTATION_ROOT = '/workspace';
export const REMOTE_WORKSTATION_AGENT_TAB_ID = 'remote-workstation-live-agent';
export const REMOTE_WORKSTATION_THREAD_MARKER = 'remote-workstation-live-thread';

const listingCache = new Map<string, PublicWorkspaceListing>();

export function isRemoteWorkstationMode(): boolean {
  return isPublicWorkstationPublication() && Boolean(getRemoteWorkstationEndpoint());
}

export function getRemoteWorkstationEndpoint(): string | null {
  return getBrowserWorkstationConnection().endpoint;
}

function remoteRelativePath(filePath: string): string {
  if (filePath === REMOTE_WORKSTATION_ROOT) return '';
  if (filePath.startsWith(`${REMOTE_WORKSTATION_ROOT}/`)) {
    return filePath.slice(REMOTE_WORKSTATION_ROOT.length + 1);
  }
  return filePath.replace(/^\/+/, '');
}

function isListing(value: unknown): value is PublicWorkspaceListing {
  if (!value || typeof value !== 'object') return false;
  const listing = value as Partial<PublicWorkspaceListing>;
  return listing.schemaVersion === 1
    && typeof listing.name === 'string'
    && typeof listing.path === 'string'
    && Array.isArray(listing.capabilities)
    && listing.capabilities.includes('browse')
    && listing.capabilities.includes('read')
    && Array.isArray(listing.entries)
    && listing.entries.every((entry) => entry
      && typeof entry.name === 'string'
      && typeof entry.path === 'string'
      && (entry.type === 'file' || entry.type === 'directory')
      && typeof entry.modifiedAt === 'number');
}

async function fetchListing(filePath = ''): Promise<PublicWorkspaceListing> {
  const endpoint = getRemoteWorkstationEndpoint();
  if (!endpoint) throw new Error('Remote Workstation endpoint is not configured');
  const relativePath = remoteRelativePath(filePath);
  const url = new URL(`${endpoint}/workspace`, window.location.href);
  if (relativePath) url.searchParams.set('path', relativePath);
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Remote workspace is unavailable (${response.status})`);
  const payload: unknown = await response.json();
  if (!isListing(payload)) throw new Error('Remote workspace returned an invalid listing');
  listingCache.set(relativePath, payload);
  return payload;
}

function toTreeEntry(entry: PublicWorkspaceEntry, prepareLazyDirectory = false) {
  return {
    name: entry.name,
    path: entry.path,
    type: entry.type,
    mtime: entry.modifiedAt,
    // react-arborist treats only array-backed nodes as expandable. An empty
    // array plus isResolved=false is Workstation's lazy-directory contract.
    ...(prepareLazyDirectory && entry.type === 'directory' ? { children: [], isResolved: false } : {}),
  };
}

export function getRemoteWorkstationWorkspace(): { workspace: string } {
  return { workspace: REMOTE_WORKSTATION_ROOT };
}

export async function getRemoteWorkstationWorkspaceFiles() {
  const listing = await fetchListing();
  return { files: listing.entries.map((entry) => toTreeEntry(entry, true)) };
}

export async function getRemoteWorkstationFolderChildren(folderPath: string) {
  const listing = await fetchListing(folderPath);
  return { children: listing.entries.map((entry) => toTreeEntry(entry)) };
}

export async function readRemoteWorkstationFile(filePath: string): Promise<{ content: string }> {
  const response = await fetch(getRemoteWorkstationFileUrl(filePath), {
    headers: { Accept: 'text/plain' },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Remote file is unavailable (${response.status})`);
  return { content: await response.text() };
}

export function getRemoteWorkstationFileUrl(filePath: string): string {
  const endpoint = getRemoteWorkstationEndpoint();
  if (!endpoint) return '';
  const url = new URL(`${endpoint}/file`, window.location.href);
  url.searchParams.set('path', remoteRelativePath(filePath));
  return url.toString();
}

async function remoteEntry(filePath: string): Promise<PublicWorkspaceEntry | null> {
  if (filePath === REMOTE_WORKSTATION_ROOT) return null;
  const relativePath = remoteRelativePath(filePath);
  const slash = relativePath.lastIndexOf('/');
  const parent = slash >= 0 ? relativePath.slice(0, slash) : '';
  const listing = listingCache.get(parent) ?? await fetchListing(parent);
  return listing.entries.find((entry) => entry.path === relativePath) ?? null;
}

export const remoteWorkstationWorkspaceIpc = {
  get: async () => getRemoteWorkstationWorkspace(),
  createSample: async () => ({ success: false, workspacePath: REMOTE_WORKSTATION_ROOT }),
  set: async () => ({ success: false }),
  addWatch: async () => ({ success: true }),
  removeWatch: async () => ({ success: true }),
  onChanged: (callback: (event: { workspacePath: string | null }) => void) => {
    queueMicrotask(() => callback({ workspacePath: REMOTE_WORKSTATION_ROOT }));
    return () => {};
  },
  onFilesChanged: () => () => {},
};

export const remoteWorkstationFilesIpc = {
  isDirectory: async (filePath: string) => ({
    isDirectory: filePath === REMOTE_WORKSTATION_ROOT || (await remoteEntry(filePath))?.type === 'directory',
  }),
  getStats: async (filePath: string) => {
    const entry = await remoteEntry(filePath);
    return {
      size: entry?.size ?? null,
      lineCount: null,
      itemCount: null,
      isDirectory: filePath === REMOTE_WORKSTATION_ROOT || entry?.type === 'directory',
    };
  },
  read: readRemoteWorkstationFile,
  write: async () => ({ success: false, error: 'Remote Workstation is read-only' }),
  getThumbnails: async (): Promise<{ thumbnails: Record<string, FileThumbnailData> }> => ({ thumbnails: {} }),
  listDirectory: async (filePath: string) => {
    try {
      const listing = await fetchListing(filePath);
      return {
        success: true,
        entries: listing.entries.map((entry) => ({
          ...toTreeEntry(entry),
          path: `${REMOTE_WORKSTATION_ROOT}/${entry.path}`,
        })),
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Remote workspace is unavailable' };
    }
  },
  create: async () => ({ success: false, error: 'Remote Workstation is read-only' }),
  createFolder: async () => ({ success: false, error: 'Remote Workstation is read-only' }),
  rename: async () => ({ success: false, error: 'Remote Workstation is read-only' }),
  move: async () => ({ success: false, error: 'Remote Workstation is read-only' }),
  delete: async () => ({ success: false, error: 'Remote Workstation is read-only' }),
  copyExternal: async () => ({ success: false, error: 'Remote Workstation is read-only' }),
  createBookmark: async () => ({ success: false, error: 'Remote Workstation is read-only' }),
  onRefreshed: () => () => {},
};

export function getRemoteWorkstationLayoutState(modelConfig: AgentModelConfig): LayoutState {
  const compactViewport = typeof window !== 'undefined' && window.innerWidth < 720;
  return {
    version: 6,
    tree: {
      kind: 'pane',
      id: 'remote-workstation-pane',
      tabIds: [REMOTE_WORKSTATION_AGENT_TAB_ID],
      activeTabId: REMOTE_WORKSTATION_AGENT_TAB_ID,
    },
    tabs: {
      [REMOTE_WORKSTATION_AGENT_TAB_ID]: {
        id: REMOTE_WORKSTATION_AGENT_TAB_ID,
        type: 'agent',
        label: 'Remote conversation',
        createdAt: Date.now(),
        agent: {
          runtime: { modelConfig, workspacePath: REMOTE_WORKSTATION_ROOT },
          session: {
            conversationId: REMOTE_WORKSTATION_THREAD_MARKER,
            codexThreadId: REMOTE_WORKSTATION_THREAD_MARKER,
            callerToken: 'agtok_remote_workstation_read_only',
          },
        },
      },
    },
    activePaneId: 'remote-workstation-pane',
    activeTabRegion: 'main',
    sidebarPane: null,
    sidebarWidth: 360,
    sidebarOpen: false,
    leftSidebar: { isOpen: !compactViewport, width: 300, activeTab: 'explorer' },
    rightSidebar: { isOpen: false, width: 360 },
  };
}
