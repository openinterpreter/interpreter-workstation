import { isBrowserDevMode, apiRequest as ipcApiRequest, getAppServerOrigin, servers, files, settings as settingsIpc } from './ipc';
import {
  getMarketingDemoDetectedNoteWorkspaces,
  getMarketingDemoWorkspacePath,
  getMarketingDemoFolderChildren,
  getMarketingDemoWorkspace,
  getMarketingDemoWorkspaceFiles,
  isMarketingDemoMode,
  readMarketingDemoFile,
  writeMarketingDemoFile,
} from './demo/marketingDemo';
import { readJsonSseStream } from './utils/sseStream';

// API Types
export interface ToolServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  transport?: 'stdio' | 'http' | 'sse' | 'websocket';
  url?: string;
  wsUrl?: string;
  headers?: Record<string, string>;
  oauthResource?: string;
  name?: string;
  enabled?: boolean;
  defaultToolsApprovalMode?: 'auto' | 'prompt' | 'approve';
  tools?: Record<string, { approvalMode?: 'auto' | 'prompt' | 'approve' }>;
}

export interface ToolSchemaDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ToolResourceDefinition {
  uri: string;
  name?: string;
}

export interface ToolPromptDefinition {
  name: string;
  description?: string;
}

export interface ToolConnectionState {
  status: 'disconnected' | 'connecting' | 'connected' | 'failed';
  tools?: ToolSchemaDefinition[];
  resources?: ToolResourceDefinition[];
  prompts?: ToolPromptDefinition[];
  error?: string;
  needsAuth?: boolean;
}

export interface ToolServer {
  id: string;
  name: string;
  description?: string;
  state: ToolConnectionState;
  config?: ToolServerConfig;
  requiresSetup?: boolean;
  setupDescription?: string;
  isConfigured?: boolean;
  email?: string;
  globallyDisabled?: boolean; // True if tool is disabled globally in Settings → Tools
}

export function toolServerNeedsAuth(server: Pick<ToolServer, 'state'>): boolean {
  return server.state.status === 'failed' && server.state.needsAuth === true;
}

// Get base URL for API calls (empty string in browser dev mode since Vite proxies)
export async function getApiBaseUrl(): Promise<string> {
  if (isBrowserDevMode()) {
    return ''; // Vite proxies /api to the server
  }
  return getAppServerOrigin();
}

// Helper function to make API requests (unwraps the IPC response format)
async function apiRequest(method: string, path: string, body?: any) {
  if (isMarketingDemoMode()) {
    throw new Error(`[MarketingDemo] ${method} ${path} is disabled.`);
  }

  if (isBrowserDevMode()) {
    // In browser dev mode, use fetch directly (vite proxies /api to backend)
    const options: RequestInit = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }
    const response = await fetch(path, options);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || `Request failed with status ${response.status}`);
    }
    return data;
  }

  // Use IPC in Electron mode, with retry for 503 (server starting up)
  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await ipcApiRequest({ method, path, body });
    if (response.status === 503 && attempt < MAX_RETRIES) {
      const delay = 500 * Math.pow(2, attempt); // 500ms, 1s, 2s, 4s, 8s
      await new Promise(resolve => setTimeout(resolve, delay));
      continue;
    }
    if (!response.ok) {
      const errorData = response.data as { error?: string } | undefined;
      throw new Error(errorData?.error || `Request failed with status ${response.status}`);
    }
    return response.data;
  }
}

// Settings/Config
export async function getConfig() {
  return apiRequest('GET', '/api/settings');
}

export async function getCustomInstructions(): Promise<{ customInstructions: string; onboardingCustomInstructionsDraft: string }> {
  return apiRequest('GET', '/api/settings/custom-instructions');
}

export async function setCustomInstructions(customInstructions: string): Promise<{ success: boolean; customInstructions: string }> {
  return apiRequest('POST', '/api/settings/custom-instructions', { customInstructions });
}

export async function resetRuntimeConfigFiles(): Promise<{
  success: boolean;
  files: Array<{
    id: 'interpreterConfigJson' | 'runtimeConfigToml';
    path: string;
    existed: boolean;
    removed: boolean;
    error?: string;
  }>;
}> {
  return settingsIpc.resetRuntimeConfigFiles();
}

// Tool Server APIs - Using IPC abstraction (servers namespace)
export async function listAllToolServers() {
  return servers.list();
}

export async function addToolServer(config: ToolServerConfig) {
  return servers.add(config);
}

export async function startToolServerOAuth(serverId: string, scopes?: string[]) {
  return servers.startOAuth(serverId, scopes);
}

export async function getToolServer(serverId: string) {
  return servers.get(serverId);
}

export async function updateToolServer(serverId: string, updates: Partial<ToolServerConfig>) {
  return servers.update(serverId, updates);
}

export async function deleteToolServer(serverId: string) {
  return servers.delete(serverId);
}

export async function toggleToolServer(serverId: string, enabled: boolean) {
  return servers.toggle(serverId, enabled);
}

export async function callTool(serverId: string, toolName: string, args: Record<string, any>, toolContext?: { profileId?: string }) {
  return servers.callTool(serverId, toolName, args, undefined, toolContext);
}

// Workspace APIs
export async function getWorkspace() {
  if (isMarketingDemoMode()) {
    return getMarketingDemoWorkspace();
  }
  return apiRequest('GET', '/api/workspace');
}

export async function setWorkspace(path: string) {
  return apiRequest('POST', '/api/workspace', { path });
}

export async function getWorkspaceFiles() {
  if (isMarketingDemoMode()) {
    return getMarketingDemoWorkspaceFiles();
  }
  return apiRequest('GET', '/api/workspace/files');
}

export async function getFolderChildren(folderPath: string) {
  if (isMarketingDemoMode()) {
    return getMarketingDemoFolderChildren(folderPath);
  }
  const encodedPath = encodeURIComponent(folderPath);
  return apiRequest('GET', `/api/workspace/folder-children?path=${encodedPath}`);
}

export async function resolveWikilink(target: string): Promise<{ path: string | null }> {
  const encoded = encodeURIComponent(target);
  return apiRequest('GET', `/api/workspace/resolve-wikilink?target=${encoded}`);
}

export interface WorkspaceContentMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export async function searchWorkspaceContent(query: string, limit = 50): Promise<{ matches: WorkspaceContentMatch[] }> {
  const encoded = encodeURIComponent(query);
  return apiRequest('GET', `/api/workspace/search-content?q=${encoded}&limit=${limit}`);
}

export interface RecentWorkspaceFolder {
  path: string;
  name: string;
  lastOpened: number;
}

export async function getRecentWorkspaces(): Promise<{ folders: RecentWorkspaceFolder[] }> {
  if (isMarketingDemoMode()) {
    return { folders: [] };
  }
  return apiRequest('GET', '/api/workspace/recent');
}

export type DetectedNoteWorkspaceSource = 'obsidian' | 'logseq' | 'dendron' | 'foam';

export interface DetectedNoteWorkspace {
  path: string;
  name: string;
  source: DetectedNoteWorkspaceSource;
}

export async function detectNoteWorkspaces(): Promise<{ workspaces: DetectedNoteWorkspace[] }> {
  if (isMarketingDemoMode()) {
    return { workspaces: getMarketingDemoDetectedNoteWorkspaces() };
  }
  return apiRequest('GET', '/api/workspace/detect-note-workspaces');
}

export interface WorkspaceTypeInfo {
  path: string;
  kind: 'obsidian-vault' | 'wiki' | 'markdown-heavy' | 'general';
  hasObsidianFolder: boolean;
  hasWikiStructure: boolean;
  hasIndexMd: boolean;
  hasLogMd: boolean;
  markdownFileCount: number;
  pdfFileCount: number;
  nonMarkdownFileCount: number;
  sampled: boolean;
}

export async function getWorkspaceType(): Promise<WorkspaceTypeInfo> {
  if (isMarketingDemoMode()) {
    return {
      path: getMarketingDemoWorkspacePath(),
      kind: 'wiki',
      hasObsidianFolder: false,
      hasWikiStructure: true,
      hasIndexMd: true,
      hasLogMd: false,
      markdownFileCount: 2,
      pdfFileCount: 0,
      nonMarkdownFileCount: 2,
      sampled: false,
    };
  }
  return apiRequest('GET', '/api/workspace/type');
}

// ===== Activity signals =====

export interface FileActivity { path: string; name: string; count: number; lastOpened: number; }
export interface SkillActivity { skillId: string; name: string; count: number; lastUsed: number; }
export interface CardActivity { cardId: string; count: number; lastClicked: number; }
export interface ActionActivity { actionId: string; count: number; lastDone: number; }

export interface ActivitySignals {
  recentFiles: FileActivity[];
  frequentFiles: FileActivity[];
  frequentSkills: SkillActivity[];
  cardClicks: Record<string, CardActivity>;
  frequentActions: ActionActivity[];
  actionCounts: Record<string, ActionActivity>;
}

export async function getActivitySignals(): Promise<ActivitySignals> {
  if (isMarketingDemoMode()) {
    return {
      recentFiles: [],
      frequentFiles: [],
      frequentSkills: [],
      cardClicks: {},
      frequentActions: [],
      actionCounts: {},
    };
  }
  return apiRequest('GET', '/api/activity/signals');
}

export async function recordFileOpenActivity(path: string): Promise<void> {
  try { await apiRequest('POST', '/api/activity/file-open', { path }); } catch { /* best-effort */ }
}
export async function recordSkillUseActivity(skillId: string, name: string): Promise<void> {
  try { await apiRequest('POST', '/api/activity/skill-use', { skillId, name }); } catch { /* best-effort */ }
}
export async function recordCardClickActivity(cardId: string): Promise<void> {
  try { await apiRequest('POST', '/api/activity/card-click', { cardId }); } catch { /* best-effort */ }
}
export async function recordUserAction(actionId: string): Promise<void> {
  try { await apiRequest('POST', '/api/activity/action', { actionId }); } catch { /* best-effort */ }
}

// File APIs
export async function readFile(path: string) {
  if (isMarketingDemoMode()) {
    return readMarketingDemoFile(path);
  }

  if (!isBrowserDevMode()) {
    // SECURITY: In Electron this goes through privileged renderer IPC so the UI
    // can open explicit user-selected files outside the workspace. Browser mode
    // stays on the workspace-scoped HTTP file API instead.
    return files.read(path);
  }
  const encodedPath = encodeURIComponent(path);
  return apiRequest('GET', `/api/files/${encodedPath}`);
}

export async function writeFile(path: string, content: string) {
  if (isMarketingDemoMode()) {
    return writeMarketingDemoFile(path, content);
  }

  if (!isBrowserDevMode()) {
    // SECURITY: Same trust boundary as readFile above. Do not replace the
    // browser-mode HTTP path with unrestricted IPC outside Electron.
    return files.write(path, content);
  }
  const encodedPath = encodeURIComponent(path);
  return apiRequest('PUT', `/api/files/${encodedPath}`, { content });
}

// Approval APIs
export async function getApprovals(options?: { toolCallId?: string }) {
  const params = new URLSearchParams();
  if (options?.toolCallId) {
    params.append('toolCallId', options.toolCallId);
  }
  const path = `/api/approvals${params.toString() ? `?${params.toString()}` : ''}`;
  return apiRequest('GET', path);
}

export async function approveApproval(id: string) {
  return apiRequest('POST', `/api/approvals/${id}/approve`);
}

export async function denyApproval(id: string) {
  return apiRequest('POST', `/api/approvals/${id}/deny`);
}

// Respond to a question/approval with full result (supports complex questions)
export async function respondApproval(id: string, result: import('../shared/types/approval').QuestionResult) {
  return apiRequest('POST', `/api/ipc/approvals/respond`, [{ id, result }]);
}

// Tool Server Setup APIs
export async function setupToolServer(serverId: string): Promise<{ setupUrl: string }> {
  return apiRequest('POST', `/api/servers/${serverId}/setup`);
}

export async function getToolServerSetupStatus(serverId: string): Promise<{ configured: boolean; email?: string }> {
  return apiRequest('GET', `/api/servers/${serverId}/setup/status`);
}

export async function disconnectToolServer(serverId: string): Promise<{ success: boolean }> {
  return apiRequest('POST', `/api/servers/${serverId}/disconnect`);
}

// Profile APIs - Use unified abstraction from @/ipc
import type { Profile } from '../shared/types/profile';
import { profiles } from './ipc';

export interface ProfilesResponse {
  profiles: Profile[];
  defaultProfileId: string | null;
  fastProfileId: string | null;
}

export async function getProfiles(): Promise<ProfilesResponse> {
  return profiles.list();
}

export async function getProfile(profileId: string): Promise<Profile> {
  return profiles.get(profileId);
}

export async function createProfile(profile: Profile): Promise<{ success: boolean; profile: Profile }> {
  return profiles.create(profile);
}

export async function updateProfile(profileId: string, updates: Partial<Profile>): Promise<{ success: boolean; profile: Profile }> {
  return profiles.update(profileId, updates);
}

export async function deleteProfile(profileId: string): Promise<{ success: boolean }> {
  return profiles.delete(profileId);
}

export async function setDefaultProfile(profileId: string): Promise<{ success: boolean; defaultProfileId: string; fastProfileId: string | null }> {
  return profiles.setDefault(profileId);
}

export async function setFastProfile(profileId: string): Promise<{ success: boolean; defaultProfileId: string | null; fastProfileId: string }> {
  return profiles.setFast(profileId);
}

export async function resetProfile(profileId: string): Promise<{ success: boolean; profile: Profile }> {
  return profiles.reset(profileId);
}

// Background Opacity APIs - Use unified abstraction from @/ipc
import { backgroundOpacity as bgOpacity } from './ipc';

export async function getBackgroundOpacity(): Promise<{ opacity: number }> {
  return bgOpacity.get();
}

export async function setBackgroundOpacity(opacity: number): Promise<{ success: boolean; opacity: number }> {
  return bgOpacity.set(opacity);
}

// Ollama/Local Model APIs
export interface OllamaModel {
  id: string;
  name: string;
  size: number;
  modified: string;
}

export async function getOllamaStatus(): Promise<{ running: boolean; error?: string }> {
  return apiRequest('GET', '/api/agent/ollama/status');
}

export async function getOllamaModels(): Promise<{ models: OllamaModel[] }> {
  return apiRequest('GET', '/api/agent/ollama/models');
}

export interface LMStudioModel {
  id: string;
  name: string;
  size: number;
  modified: string;
}

export async function getLmStudioStatus(): Promise<{ running: boolean; error?: string }> {
  return apiRequest('GET', '/api/agent/lmstudio/status');
}

export async function getLmStudioModels(): Promise<{ models: LMStudioModel[] }> {
  return apiRequest('GET', '/api/agent/lmstudio/models');
}

// Ollama model pull progress event
export interface OllamaPullProgress {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  done?: boolean;
  error?: string;
  code?: string;
}

export interface LMStudioDownloadProgress {
  status?: string;
  total?: number;
  completed?: number;
  progress?: number;
  maxProgress?: number;
  text?: string;
  jobId?: string;
  done?: boolean;
  error?: string;
  code?: string;
}

// Pull (download) an Ollama model with streaming progress
export async function pullOllamaModel(
  model: string,
  onProgress?: (progress: OllamaPullProgress) => void,
  baseURL?: string
): Promise<{ success: boolean; error?: string }> {
  const baseUrl = await getApiBaseUrl();
  const url = `${baseUrl}/api/agent/ollama/pull`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        ...(baseURL ? { baseURL } : {}),
      }),
    });

    // Check for non-streaming error response
    if (!response.ok) {
      const contentType = response.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        const errorData = await response.json() as { error?: string; code?: string };
        return { success: false, error: errorData.error || `HTTP ${response.status}` };
      }
      return { success: false, error: `HTTP ${response.status}` };
    }

    if (!response.body) {
      return { success: false, error: 'No response body' };
    }

    let success = false;

    for await (const data of readJsonSseStream<OllamaPullProgress>(response.body, { streamName: 'ollama-model-pull' })) {
      onProgress?.(data);

      if (data.done && data.status === 'success') {
        success = true;
      }
      if (data.error) {
        return { success: false, error: data.error };
      }
    }

    return { success };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// Download an LM Studio model with streaming progress
export async function downloadLmStudioModel(
  model: string,
  onProgress?: (progress: LMStudioDownloadProgress) => void,
  baseURL?: string
): Promise<{ success: boolean; error?: string }> {
  const baseUrl = await getApiBaseUrl();
  const url = `${baseUrl}/api/agent/lmstudio/download`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        ...(baseURL ? { baseURL } : {}),
      }),
    });

    if (!response.ok) {
      const contentType = response.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        const errorData = await response.json() as { error?: string; code?: string };
        return { success: false, error: errorData.error || `HTTP ${response.status}` };
      }
      return { success: false, error: `HTTP ${response.status}` };
    }

    if (!response.body) {
      return { success: false, error: 'No response body' };
    }

    let success = false;

    for await (const data of readJsonSseStream<LMStudioDownloadProgress>(response.body, { streamName: 'lmstudio-model-download' })) {
      onProgress?.(data);

      if (data.done && data.status === 'success') {
        success = true;
      }
      if (data.error) {
        return { success: false, error: data.error };
      }
    }

    return { success };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

// User Name APIs - Use unified abstraction from @/ipc
import { onboardingState as onboardingStateIpc, userName as userNameIpc, whatsNew as whatsNewIpc } from './ipc';
import type { OnboardingState } from '../shared/types/onboardingState';

export async function getUserName(): Promise<{ userName: string | null }> {
  return userNameIpc.get();
}

export async function setUserName(name: string): Promise<{ success: boolean; userName: string }> {
  return userNameIpc.set(name);
}

export async function clearUserName(): Promise<{ success: boolean }> {
  return userNameIpc.clear();
}

export async function getOnboardingState(): Promise<{ state: OnboardingState }> {
  return onboardingStateIpc.get();
}

export async function setOnboardingState(state: OnboardingState): Promise<{ success: boolean; state: OnboardingState }> {
  return onboardingStateIpc.set(state);
}

export async function resetOnboardingState(): Promise<{ success: boolean; state: OnboardingState }> {
  return onboardingStateIpc.reset();
}

// What's New APIs
export async function getWhatsNewDismissed(): Promise<{ dismissed: boolean }> {
  return whatsNewIpc.getDismissed();
}

export async function setWhatsNewDismissed(dismissed: boolean): Promise<{ success: boolean }> {
  return whatsNewIpc.setDismissed(dismissed);
}
