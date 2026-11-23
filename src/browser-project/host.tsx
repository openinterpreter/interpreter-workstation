import { createContext, useContext, useLayoutEffect, type ReactNode } from 'react';
import { disableBrowserProjectNativeEvents, registerBrowserProjectHostCapabilities,
  registerBrowserProjectIdentity, registerBrowserProjectLocalProfile,
  restoreBrowserProjectNativeEvents } from '../ipc';
import type { StreamRequestBody } from '../lib/codex/api-types';
import type { AppServerNotification, RequestMap } from '../lib/codex/protocol';
import type { BrowserProjectFiles } from './workspace';
import type { HostCapabilities } from '../../shared/types/hostCapabilities';
import { BROWSER_PROJECT_CAPABILITIES } from '../../shared/types/hostCapabilities';
export { resolveBrowserProjectWorkspace } from './workspace';
export type { BrowserProjectFiles } from './workspace';

/** Backend injection uses the existing app-server request and notification contract. */
export type BrowserProjectSession = Readonly<{
  projectId: string;
  threadId: string;
  model: Readonly<{ id: string; name: string }>;
  appServer: {
    request<M extends keyof RequestMap>(method: M, params: RequestMap[M]['params']):
      Promise<RequestMap[M]['result']>;
    subscribe(listener: (notification: AppServerNotification) => void): () => void;
  };
  stream(request: StreamRequestBody, signal?: AbortSignal): Response;
  dispose(): void;
}>;

/** A project can enumerate and acquire models before opening its first thread. */
export type BrowserProjectBackend = Readonly<{
  projectId: string;
  request<M extends keyof RequestMap>(method: M, params: RequestMap[M]['params']):
    Promise<RequestMap[M]['result']>;
  downloadModel: (providerId: string, modelId: string,
    onProgress: (progress: BrowserModelDownloadProgress) => void,
    signal?: AbortSignal) => Promise<void>;
  openSession(modelId: string): Promise<BrowserProjectSession>;
}>;

export type BrowserModelDownloadProgress = { total?: number; completed?: number;
  status?: string; done?: boolean; error?: string };

export type BrowserProjectHost = Readonly<{
  session: BrowserProjectSession;
  workspacePath: string;
  projectFiles: BrowserProjectFiles;
  capabilities: HostCapabilities;
  downloadModel?: BrowserProjectBackend['downloadModel'];
}>;

export function activateBrowserProjectBackend(backend: BrowserProjectBackend): number {
  disableBrowserProjectNativeEvents();
  const activation = registerBrowserProjectIdentity(backend.projectId);
  registerBrowserProjectHostCapabilities(BROWSER_PROJECT_CAPABILITIES, backend.downloadModel,
    backend.request.bind(backend));
  return activation;
}

export function createBrowserProjectHost(session: BrowserProjectSession,
  projectFiles: BrowserProjectFiles,
  downloadModel?: BrowserProjectHost['downloadModel']): BrowserProjectHost {
  if (!session || typeof projectFiles?.isDirectory !== 'function')
    throw new Error('Browser project session and real ProjectFiles capability required');
  return Object.freeze({ session, projectFiles, capabilities: BROWSER_PROJECT_CAPABILITIES,
    downloadModel, workspacePath: `browser-project:${session.projectId}` });
}

const Context = createContext<BrowserProjectHost | null>(null);

export function BrowserProjectHostProvider({ host, children, restoreOnUnmount = true }: {
  host: BrowserProjectHost;
  children: ReactNode;
  /** The pre-session entry owns the native gate when this provider is nested. */
  restoreOnUnmount?: boolean;
}) {
  useLayoutEffect(() => {
    // Reapply after React StrictMode's development cleanup/setup cycle; the
    // initial createBrowserProjectHost activation still precedes child effects.
    disableBrowserProjectNativeEvents();
    registerBrowserProjectHostCapabilities(host.capabilities, host.downloadModel,
      host.session.appServer.request.bind(host.session.appServer));
    registerBrowserProjectLocalProfile(host.session.projectId, host.session.model.id,
      host.session.model.name);
    return () => { if (restoreOnUnmount) restoreBrowserProjectNativeEvents(host.session.projectId); };
  }, [host, restoreOnUnmount]);
  return <Context.Provider value={host}>{children}</Context.Provider>;
}

export function useBrowserProjectHost(): BrowserProjectHost | null {
  return useContext(Context);
}
