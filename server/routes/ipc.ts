/**
 * IPC HTTP Router for Browser Dev Mode
 *
 * THIN ROUTER - No business logic here!
 * All business logic lives in server/handlers/*.ts
 *
 * This router provides HTTP endpoints that mirror the IPC handlers,
 * allowing the browser dev mode to use the same APIs as Electron mode.
 *
 * Endpoint format: POST /api/ipc/:namespace/:method
 * Request body: array of arguments
 * Response: handler result
 */

import { Router, Request, Response } from 'express';
import { createRequire } from 'node:module';
import * as configStore from '../configStore';
import { BOOLEAN_UI_SETTING_IDS } from '../../shared/booleanSettings';
import { distributionProductConfig } from '../../shared/productConfig';

const INTERVIEW_INVITE_VERSION = '0.2.99-automation-services';
const INTERVIEW_INVITE_MIN_APP_LAUNCH_COUNT = 1;
import type { TtsModelId, TtsProvider, TtsSettings } from '../../shared/types/tts';
import type { SttSettings } from '../../shared/types/stt';
import type { EnvApiKeyType } from '../../shared/types/provider';
import { PRELAUNCH_SECURITY_DISABLE_HTTP_TOOL_EXECUTION } from '../securityFlags';
import type { v2 } from '../handlers/codex-generated-types';

const runtimeRequire = createRequire(process.execPath);

// Remotion is dev-only (license does not permit redistribution in packaged apps)
const isDevMode = (() => {
  if (!process.versions.electron) return false;
  try { return !runtimeRequire('electron').app.isPackaged; } catch { return false; }
})();

const router = Router();
const ipcErrorRepeatCounts = new Map<string, number>();

// ============================================================================
// Handler Definitions (Thin wrappers - all logic in server/handlers/)
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HandlerFn = (...args: any[]) => Promise<unknown> | unknown;

const handlers: Record<string, Record<string, HandlerFn>> = {
  // ========== Approvals ==========
  approvals: {
    get: async ([request]: [{ toolCallId?: string }?]) => {
      const { getApprovals } = await import('../handlers/approvals');
      return getApprovals(request?.toolCallId);
    },
    approve: async ([request]: [{ id: string }]) => {
      const { approve } = await import('../handlers/approvals');
      return approve(request.id);
    },
    deny: async ([request]: [{ id: string }]) => {
      const { deny } = await import('../handlers/approvals');
      return deny(request.id);
    },
    respond: async ([request]: [{ id: string; result: import('../../shared/types/approval').QuestionResult }]) => {
      const { respond } = await import('../handlers/approvals');
      return respond(request.id, request.result);
    },
  },

  // ========== Agent Tabs ==========
  agentTabs: {
    created: async ([data]: [any]) => {
      const { onTabCreated } = await import('../handlers/agentTabs');
      return onTabCreated(data.requestId, data.agentId);
    },
    completed: async ([data]: [any]) => {
      const { onTabCompleted } = await import('../handlers/agentTabs');
      return onTabCompleted(data.requestId, data.messages, data.error);
    },
    getPending: async () => {
      const { getPendingRequests } = await import('../handlers/agentTabs');
      return getPendingRequests();
    },
    consumeStartup: async ([data]: [{
      agentId: string;
      startupId: string;
    }]) => {
      const { consumeStartup } = await import('../handlers/agentTabs');
      return consumeStartup(data.startupId, data.agentId);
    },
    registerThread: async ([data]: [{
      agentId: string;
      threadId: string;
      callerToken: string;
      workspacePath?: string;
      allowedToolNames?: string[];
      modelConfig?: import('../../shared/types/model').AgentModelConfig;
      toolProfileId?: string;
    }]) => {
      const { bindThread } = await import('../handlers/agentTabs');
      return bindThread(data.agentId, data.threadId, data.callerToken, {
        workspacePath: data.workspacePath,
        allowedToolNames: data.allowedToolNames,
        modelConfig: data.modelConfig,
        toolProfileId: data.toolProfileId,
      });
    },
    reportActivity: async ([data]: [{
      agentId: string;
      activity: Partial<import('../../shared/utils/agentAttention').AgentActivityState>;
    }]) => {
      const { reportActivity } = await import('../handlers/agentTabs');
      return reportActivity(data.agentId, data.activity);
    },
    disposeBinding: async ([data]: [{
      callerToken: string;
    }]) => {
      const { disposeBinding } = await import('../handlers/agentTabs');
      return disposeBinding(data.callerToken);
    },
  },

  // ========== Workspace ==========
  workspace: {
    get: async () => {
      const { getWorkspace } = await import('../handlers/workspace');
      return getWorkspace();
    },
    createSample: async () => {
      const { createSampleWorkspace } = await import('../handlers/workspace');
      return createSampleWorkspace();
    },
    set: async ([arg]: [{ workspacePath: string }]) => {
      const { setWorkspace } = await import('../handlers/workspace');
      return setWorkspace(arg.workspacePath);
    },
    rename: async ([arg]: [{ oldPath: string; newName: string }]) => {
      const { renameWorkspace, saveLastWorkspace } = await import('../workspacePersistence');
      const newPath = await renameWorkspace(arg.oldPath, arg.newName);
      if (newPath) {
        await saveLastWorkspace(newPath);
        return { success: true, newPath };
      }
      return { success: false, error: 'Failed to rename workspace' };
    },
    addWatch: async ([folderPath]: [string]) => {
      const { addWatch } = await import('../handlers/workspace');
      return addWatch(folderPath);
    },
    removeWatch: async ([folderPath]: [string]) => {
      const { removeWatch } = await import('../handlers/workspace');
      return removeWatch(folderPath);
    },
  },

  // ========== Vault ==========
  vault: {
    getSnapshot: async () => {
      const { getSnapshot } = await import('../handlers/vault');
      return getSnapshot();
    },
    getNoteContext: async ([request]: [{ filePath: string }]) => {
      const { getNoteContext } = await import('../handlers/vault');
      return getNoteContext(request.filePath);
    },
    getTags: async ([request]: [{ limit?: number }?]) => {
      const { getTags } = await import('../handlers/vault');
      return getTags(request?.limit);
    },
    searchNotes: async ([request]: [{ query: string; limit?: number }]) => {
      const { searchNotes } = await import('../handlers/vault');
      return searchNotes(request.query, request.limit);
    },
  },

  // ========== Settings ==========
  settings: {
    get: async () => {
      return await configStore.loadConfigWithModelState();
    },
    reset: async () => {
      await configStore.resetConfig();
      return { success: true };
    },
    getBackgroundOpacity: async () => {
      const { getBackgroundOpacity } = await import('../handlers/settings');
      return getBackgroundOpacity();
    },
    setBackgroundOpacity: async ([opacity]: [number]) => {
      const { setBackgroundOpacity } = await import('../handlers/settings');
      return setBackgroundOpacity(opacity);
    },
    resetRuntimeConfigFiles: async () => {
      const { resetRuntimeConfigFiles } = await import('../handlers/settings');
      return resetRuntimeConfigFiles();
    },
  },

  // ========== Profiles ==========
  profiles: {
    list: async () => {
      const { listProfiles } = await import('../handlers/profiles');
      return listProfiles();
    },
    get: async ([profileId]: [string]) => {
      const { getProfile } = await import('../handlers/profiles');
      return getProfile(profileId);
    },
    create: async ([profile]: [any]) => {
      const { createProfile } = await import('../handlers/profiles');
      return createProfile(profile);
    },
    update: async ([profileId, updates]: [string, any]) => {
      const { updateProfile } = await import('../handlers/profiles');
      return updateProfile(profileId, updates);
    },
    delete: async ([profileId]: [string]) => {
      const { deleteProfile } = await import('../handlers/profiles');
      return deleteProfile(profileId);
    },
    setDefault: async ([profileId]: [string]) => {
      const { setDefaultProfile } = await import('../handlers/profiles');
      return setDefaultProfile(profileId);
    },
    setFast: async ([profileId]: [string]) => {
      const { setFastProfile } = await import('../handlers/profiles');
      return setFastProfile(profileId);
    },
    reset: async ([profileId]: [string]) => {
      const { resetProfile } = await import('../handlers/profiles');
      return resetProfile(profileId);
    },
  },

  // ========== User Name ==========
  userName: {
    get: async () => {
      const userName = await configStore.getUserName();
      return { userName };
    },
    set: async ([name]: [string]) => {
      await configStore.setUserName(name);
      return { success: true, userName: name };
    },
    clear: async () => {
      await configStore.clearUserName();
      return { success: true };
    },
  },

  // ========== User Email ==========
  userEmail: {
    get: async () => {
      const email = await configStore.getUserEmail();
      return { email };
    },
    set: async ([email]: [string]) => {
      await configStore.setUserEmail(email);
      return { success: true, email };
    },
  },

  // ========== Onboarding Persona ==========
  onboardingPersona: {
    get: async () => {
      const persona = await configStore.getOnboardingPersona();
      return { persona };
    },
    set: async ([persona]: [{ bucket: 'non-developer' | 'developer' | 'developer-local-ai'; subCategories: string[]; detectedProviders: string[] }]) => {
      await configStore.setOnboardingPersona(persona);
      return { success: true };
    },
  },

  // ========== Onboarding State ==========
  onboardingState: {
    get: async () => {
      const state = await configStore.getOnboardingState();
      return { state };
    },
    set: async ([state]: [import('../../shared/types/onboardingState').OnboardingState]) => {
      await configStore.setOnboardingState(state);
      return { success: true, state };
    },
    reset: async () => {
      await configStore.resetOnboardingState();
      const state = await configStore.getOnboardingState();
      return { success: true, state };
    },
  },

  // ========== Onboarding Permissions ==========
  onboardingPermissions: {
    get: async () => {
      const permissions = await configStore.getPermissions();
      return { permissions };
    },
    set: async ([permissions]: [{ readOutsideWorkspace: 'deny' | 'allow'; writeFilesInWorkspace: boolean }]) => {
      await configStore.setPermissions(permissions);
      return { success: true };
    },
  },

  // ========== Environment Detection ==========
  environmentDetection: {
    detect: async () => {
      const { detectEnvironment } = await import('../environmentDetection');
      const { derivePersona } = await import('../derivePersona');
      const signals = await detectEnvironment();
      const persona = derivePersona(signals);
      return { signals, persona };
    },
  },

  // ========== Newsletter ==========
  newsletter: {
    subscribe: async ([email]: [string]) => {
      const { distributionProductConfig } = await import('../../shared/productConfig');
      const apiUrl = distributionProductConfig.newsletterUrl;
      if (!apiUrl) {
        throw new Error('Newsletter subscription is not configured for this distribution.');
      }
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!response.ok) {
        throw new Error(`Newsletter subscription failed (${response.status})`);
      }
      return { success: true };
    },
  },

  // ========== Locale ==========
  locale: {
    get: async () => {
      const { getLanguage } = await import('../handlers/settings');
      return getLanguage();
    },
    set: async ([request]: [{ language: string }]) => {
      const { setLanguage } = await import('../handlers/settings');
      return setLanguage(request.language);
    },
  },

  // ========== What's New ==========
  whatsNew: {
    getDismissed: async () => {
      const dismissed = await configStore.getWhatsNewDismissed();
      return { dismissed };
    },
    setDismissed: async ([dismissed]: [boolean]) => {
      await configStore.setWhatsNewDismissed(dismissed);
      return { success: true };
    },
  },

  // ========== Top Notices ==========
  topNotices: {
    list: async () => {
      const { listTopNotices } = await import('../handlers/topNotices');
      return listTopNotices();
    },
    dismiss: async ([noticeId]: [string]) => {
      const { dismissTopNotice } = await import('../handlers/topNotices');
      return dismissTopNotice(noticeId);
    },
  },

  // ========== Interview Invite ==========
  interviewInvite: {
    getStatus: async () => {
      const [dismissedVersion, appLaunchCount] = await Promise.all([
        configStore.getLastDismissedInterviewInviteVersion(),
        configStore.getAppLaunchCount(),
      ]);
      return {
        currentVersion: INTERVIEW_INVITE_VERSION,
        show:
          Boolean(distributionProductConfig.interviewBookingUrl) &&
          dismissedVersion !== INTERVIEW_INVITE_VERSION &&
          appLaunchCount >= INTERVIEW_INVITE_MIN_APP_LAUNCH_COUNT,
        bookingUrl: distributionProductConfig.interviewBookingUrl,
      };
    },
    dismissCurrent: async () => {
      await configStore.setLastDismissedInterviewInviteVersion(INTERVIEW_INVITE_VERSION);
      return { success: true, dismissedVersion: INTERVIEW_INVITE_VERSION };
    },
  },

  // ========== Telemetry ==========
  telemetry: {
    get: async () => {
      const enabled = await configStore.getTelemetryEnabled();
      return { enabled };
    },
    set: async ([enabled]: [boolean]) => {
      await configStore.setTelemetryEnabled(enabled);
      return { success: true, enabled };
    },
    track: async ([event, data, tag]: [string, Record<string, unknown>, string?]) => {
      // Track telemetry event from frontend (respects telemetryEnabled setting)
      const { sendTelemetry } = await import('../telemetry');
      await sendTelemetry('info', { event, ...data }, { tag });
      return { success: true };
    },
    trackOnboarding: async ([step, details]: [string, Record<string, unknown>?]) => {
      // Track onboarding events
      const { trackOnboarding } = await import('../telemetry');
      await trackOnboarding(step, details);
      return { success: true };
    },
    trackError: async ([errorType, error, context]: [string, string, Record<string, unknown>?]) => {
      // Track errors
      const { trackError } = await import('../telemetry');
      await trackError(errorType, error, context);
      return { success: true };
    },
  },

  // ========== Providers ==========
  providers: {
    list: async () => {
      const { listProviders } = await import('../handlers/providers');
      return listProviders();
    },
    get: async ([providerId]: [string]) => {
      const { getProvider } = await import('../handlers/providers');
      return getProvider(providerId);
    },
    create: async ([provider]: [any]) => {
      const { createProvider } = await import('../handlers/providers');
      return createProvider(provider);
    },
    update: async ([providerId, updates]: [string, any]) => {
      const { updateProvider } = await import('../handlers/providers');
      return updateProvider(providerId, updates);
    },
    delete: async ([providerId]: [string]) => {
      const { deleteProvider } = await import('../handlers/providers');
      return deleteProvider(providerId);
    },
    reset: async ([providerId]: [string]) => {
      const { resetProvider } = await import('../handlers/providers');
      return resetProvider(providerId);
    },
    initiateOAuth: async ([providerType]: ['openai' | 'claude']) => {
      const { initiateOAuth } = await import('../handlers/providers');
      return initiateOAuth(providerType);
    },
    completeOAuth: async ([providerType, code, flowId]: ['openai' | 'claude', string, string]) => {
      const { completeOAuth } = await import('../handlers/providers');
      return completeOAuth(providerType, code, flowId);
    },
    getOAuthStatus: async ([providerType]: ['openai' | 'claude']) => {
      const { getOAuthStatus } = await import('../handlers/providers');
      return getOAuthStatus(providerType);
    },
    listOpenAIOAuthModels: async () => {
      const { listOpenAIOAuthModels } = await import('../handlers/providers');
      return listOpenAIOAuthModels();
    },
    listOpenRouterModels: async ([options]: [{ forceRefresh?: boolean }?]) => {
      const { listOpenRouterModels } = await import('../handlers/providers');
      return listOpenRouterModels(options);
    },
    listDeepSeekModels: async ([apiKey]: [string]) => {
      const { listDeepSeekModels } = await import('../handlers/providers');
      return listDeepSeekModels(apiKey);
    },
    listInterpreterProviders: async ([includeUnconfigured]: [boolean?]) => {
      const { listInterpreterProviders } = await import('../handlers/providers');
      return listInterpreterProviders(includeUnconfigured);
    },
    setInterpreterProvider: async ([providerId, profile]: [string, string?]) => {
      const { setInterpreterProvider } = await import('../handlers/providers');
      return setInterpreterProvider(providerId, profile);
    },
    listInterpreterModels: async ([providerId, includeHidden]: [string?, boolean?]) => {
      const { listInterpreterModels } = await import('../handlers/providers');
      return listInterpreterModels(providerId, includeHidden);
    },
    setInterpreterModel: async ([model, reasoningEffort, profile]: [
      string,
      v2.InterpreterModelSetParams["reasoningEffort"]?,
      string?,
    ]) => {
      const { setInterpreterModel } = await import('../handlers/providers');
      return setInterpreterModel(model, reasoningEffort, profile);
    },
    listInterpreterHarnesses: async ([providerId, model]: [string, string?]) => {
      const { listInterpreterHarnesses } = await import('../handlers/providers');
      return listInterpreterHarnesses(providerId, model);
    },
    setInterpreterHarness: async ([harness, profile]: [string?, string?]) => {
      const { setInterpreterHarness } = await import('../handlers/providers');
      return setInterpreterHarness(harness, profile);
    },
    disconnectOAuth: async ([providerType]: ['openai' | 'claude']) => {
      const { disconnectOAuth } = await import('../handlers/providers');
      return disconnectOAuth(providerType);
    },
    getOllamaStatus: async ([baseURL, apiKey]: [string?, string?]) => {
      const { getOllamaStatus } = await import('../handlers/providers');
      return getOllamaStatus(baseURL, apiKey);
    },
    getLmStudioStatus: async ([baseURL, apiKey]: [string?, string?]) => {
      const { getLmStudioStatus } = await import('../handlers/providers');
      return getLmStudioStatus(baseURL, apiKey);
    },
    getEnvApiKeys: async () => {
      const { getEnvApiKeys } = await import('../handlers/providers');
      return getEnvApiKeys();
    },
    getEnvApiKey: async ([type]: [EnvApiKeyType]) => {
      const { getEnvApiKey } = await import('../handlers/providers');
      return { key: getEnvApiKey(type) };
    },
    getClaudeCodeStatus: async () => {
      const { getClaudeCodeStatus } = await import('../handlers/providers');
      return getClaudeCodeStatus();
    },
    runClaudeLogin: async () => {
      const { runClaudeLogin } = await import('../handlers/providers');
      return runClaudeLogin();
    },
    setClaudeCodePath: async ([customPath]: [string | null]) => {
      const { setClaudeCodePath } = await import('../handlers/providers');
      return setClaudeCodePath(customPath);
    },
    setCodexPath: async ([customPath]: [string | null]) => {
      const { setCodexPath } = await import('../handlers/providers');
      return setCodexPath(customPath);
    },
    getCodexStatus: async () => {
      const { getCodexStatus } = await import('../handlers/providers');
      return getCodexStatus();
    },
    getGitHubCliAuth: async () => {
      const { getGitHubCliAuth } = await import('../handlers/providers');
      return getGitHubCliAuth();
    },
    addGitHubMcpServerFromCliAuth: async () => {
      const { addGitHubMcpServerFromCliAuth } = await import('../handlers/providers');
      return addGitHubMcpServerFromCliAuth();
    },
    probeResponsesApiSupport: async ([baseURL]: [string]) => {
      const { probeResponsesApiSupport } = await import('../handlers/providers');
      return probeResponsesApiSupport(baseURL);
    },
    rescanBinaryPaths: async () => {
      const { rescanBinaryPaths } = await import('../handlers/providers');
      return rescanBinaryPaths();
    },
    getAllProfileStatuses: async ([isAuthenticated]: [boolean?]) => {
      const { getAllProfileStatuses } = await import('../handlers/providers');
      return getAllProfileStatuses(isAuthenticated);
    },
  },

  // ========== Tool Servers ==========
  toolServers: {
    getSnapshot: async () => {
      const { getToolServersSnapshot } = await import('../handlers/toolServers');
      return getToolServersSnapshot();
    },
  },

  // ========== Server CRUD + Tool Calls ==========
  servers: {
    list: async () => {
      const { listToolServers } = await import('../handlers/toolServers');
      return listToolServers();
    },
    get: async ([serverId]: [string]) => {
      const { getToolServer } = await import('../handlers/toolServers');
      return getToolServer(serverId);
    },
    add: async ([config]: [any]) => {
      const { addToolServer } = await import('../handlers/toolServers');
      return addToolServer(config);
    },
    startOAuth: async ([serverId, scopes]: [string, string[] | undefined]) => {
      const { startToolServerOAuth } = await import('../handlers/toolServers');
      return startToolServerOAuth(serverId, scopes);
    },
    update: async ([serverId, updates]: [string, any]) => {
      const { updateToolServer } = await import('../handlers/toolServers');
      return updateToolServer(serverId, updates);
    },
    delete: async ([serverId]: [string]) => {
      const { deleteToolServer } = await import('../handlers/toolServers');
      return deleteToolServer(serverId);
    },
    toggle: async ([serverId, enabled]: [string, boolean]) => {
      const { toggleToolServer } = await import('../handlers/toolServers');
      return toggleToolServer(serverId, enabled);
    },
    callTool: async ([serverId, toolName, args, saveToDisk, toolContext]: [string, string, Record<string, unknown>, boolean?, {
      profileId?: string;
      callerTabId?: string;
      workspace?: string;
      modelConfig?: import('../../shared/types/model').AgentModelConfig;
    }?]) => {
      const { callTool } = await import('../handlers/toolServers');
      return callTool(serverId, toolName, args, saveToDisk, toolContext);
    },
  },

  // ========== MCP Discovery ==========
  mcpDiscovery: {
    importedSetup: async () => {
      const { getImportedAiSetup } = await import('../handlers/importedAiSetup');
      return getImportedAiSetup();
    },
    installImportedCandidate: async ([candidateId]: [string]) => {
      const { installImportedMcpCandidate } = await import('../handlers/importedAiSetup');
      return installImportedMcpCandidate(candidateId);
    },
    discover: async () => {
      const { discoverMcps } = await import('../handlers/mcpDiscovery');
      return discoverMcps();
    },
    deepScan: async () => {
      const { deepScanForMcps } = await import('../handlers/mcpDiscovery');
      return deepScanForMcps();
    },
  },

  // ========== Checkpoint ==========
  checkpoint: {
    get: async ([messageId]: [string]) => {
      const { getCheckpoint } = await import('../handlers/checkpoint');
      return getCheckpoint(messageId);
    },
    restore: async ([messageId, type, paths]: [string, 'before' | 'after', string[]?]) => {
      const { restoreCheckpoint } = await import('../handlers/checkpoint');
      return restoreCheckpoint(messageId, type, paths);
    },
    getSettings: async () => {
      const { getCheckpointSettings } = await import('../handlers/checkpoint');
      return getCheckpointSettings();
    },
    setSettings: async ([settings]: [any]) => {
      const { setCheckpointSettings } = await import('../handlers/checkpoint');
      return setCheckpointSettings(settings);
    },
  },

  // ========== Conversations ==========
  conversations: {
    save: async ([request]: [{ workspace: string; conversation: any }]) => {
      const { saveConversation } = await import('../handlers/conversations');
      return saveConversation(request.workspace, request.conversation);
    },
    load: async ([request]: [{ workspace: string; conversationId: string }]) => {
      const { loadConversation } = await import('../handlers/conversations');
      return loadConversation(request.workspace, request.conversationId);
    },
    list: async ([request]: [{ workspace?: string }?]) => {
      const { listConversations } = await import('../handlers/conversations');
      return listConversations(request?.workspace);
    },
    listWithPreviews: async ([request]: [{ workspace?: string }?]) => {
      const { listConversationsWithPreviews } = await import('../handlers/conversations');
      return listConversationsWithPreviews(request?.workspace);
    },
    delete: async ([request]: [{ workspace: string; conversationId: string }]) => {
      const { deleteConversation } = await import('../handlers/conversations');
      return deleteConversation(request.workspace, request.conversationId);
    },
  },

  // ========== Files ==========
  files: {
    move: async ([sourcePath, destPath]: [string, string]) => {
      const { moveFile } = await import('../handlers/files');
      return moveFile(sourcePath, destPath);
    },
    rename: async ([filePath, newName]: [string, string]) => {
      const { renameFile } = await import('../handlers/files');
      return renameFile(filePath, newName);
    },
    delete: async ([filePath]: [string]) => {
      const { trashFile } = await import('../handlers/files');
      return trashFile(filePath);
    },
    trash: async ([filePath]: [string]) => {
      const { trashFile } = await import('../handlers/files');
      return trashFile(filePath);
    },
    duplicate: async ([filePath]: [string]) => {
      const { duplicateFile } = await import('../handlers/files');
      return duplicateFile(filePath);
    },
    copyPath: async ([filePath]: [string]) => {
      const { copyPath } = await import('../handlers/files');
      return copyPath(filePath);
    },
    create: async ([type, workspacePath]: ['note' | 'document' | 'spreadsheet' | 'slides' | 'automation' | 'remotion' | 'movie', string]) => {
      const { createFile } = await import('../handlers/files');
      return createFile(type, workspacePath);
    },
    createFolder: async ([parentPath, name]: [string, string | undefined]) => {
      const { createFolder } = await import('../handlers/files');
      return createFolder(parentPath, name);
    },
    createBookmark: async ([url, title, faviconUrl, destFolder]: [string, string, string | undefined, string]) => {
      const { createBookmark } = await import('../handlers/files');
      return createBookmark(url, title, faviconUrl, destFolder);
    },
    getStats: async ([filePath]: [string]) => {
      const { getFileStats } = await import('../handlers/files');
      return getFileStats(filePath);
    },
  },

  // Remotion is dev-only (license does not permit redistribution in packaged apps)
  ...(isDevMode ? {
    remotion: {
      openProject: async ([manifestPath]: [string]) => {
        const { openRemotionProject } = await import('../handlers/remotion');
        return openRemotionProject(manifestPath);
      },
    },
  } : {}),

  // ========== Shell ==========
  shell: {
    revealInFinder: async ([filePath]: [string]) => {
      const { revealInFinder } = await import('../handlers/shell');
      return revealInFinder(filePath);
    },
    openExternal: async ([url]: [string]) => {
      const { openExternal } = await import('../handlers/shell');
      return openExternal(url);
    },
  },

  // ========== PDF ==========
  pdf: {
    updateFormData: async () => {
      // Notification only - actual persistence is via /api/pdf/formfields/save
      return { success: true };
    },
  },

  // ========== OfficeExtension ==========
  officeExtension: {
    convert: async () => {
      return { success: false, error: 'Not available in browser mode' };
    },
    download: async () => {
      return { success: false, error: 'Not available in browser mode' };
    },
    status: async () => {
      return { running: false };
    },
    ensureRunning: async () => {
      return { success: false, error: 'Not available in browser mode' };
    },
    checkInstalled: async () => {
      return { installed: false };
    },
    install: async () => {
      return { success: false, error: 'Not available in browser mode' };
    },
    uninstall: async () => {
      return { success: false, error: 'Not available in browser mode' };
    },
  },

  // ========== Text-to-Speech ==========
  tts: {
    getSettings: async () => {
      const ttsHandlers = await import('../handlers/tts');
      return ttsHandlers.getSettings();
    },
    setSettings: async ([request]: [{ settings: Record<string, unknown> }]) => {
      const ttsHandlers = await import('../handlers/tts');
      return ttsHandlers.setSettings(request.settings as Partial<TtsSettings>);
    },
    listModels: async () => {
      const ttsHandlers = await import('../handlers/tts');
      return ttsHandlers.listModels();
    },
    installModel: async ([request]: [{ modelId: TtsModelId }]) => {
      const ttsHandlers = await import('../handlers/tts');
      return ttsHandlers.installModel(request.modelId);
    },
    getVoices: async ([request]: [{ modelId?: TtsModelId }?]) => {
      const ttsHandlers = await import('../handlers/tts');
      return ttsHandlers.getVoices(request?.modelId);
    },
    speak: async ([request]: [{
      text?: string;
      inputPath?: string;
      outputPath?: string;
      play?: boolean;
      source?: 'manual' | 'assistant-auto';
      requestTag?: string;
      messageId?: string;
      sentenceIndex?: number;
      modelId?: TtsModelId;
      voiceId?: number;
      speed?: number;
      provider?: TtsProvider;
    }]) => {
      const ttsHandlers = await import('../handlers/tts');
      return ttsHandlers.speakText(request);
    },
  },

  // ========== Speech-to-Text ==========
  stt: {
    getSettings: async () => {
      const sttHandlers = await import('../handlers/stt');
      return sttHandlers.getSettings();
    },
    setSettings: async ([request]: [{ settings: Record<string, unknown> }]) => {
      const sttHandlers = await import('../handlers/stt');
      return sttHandlers.setSettings(request.settings as Partial<SttSettings>);
    },
  },

  // ========== Browser (embedded browser) ==========
  browser: {
    create: async () => {
      return { success: false, error: 'Not available in browser mode' };
    },
    navigate: async () => {
      return { success: false };
    },
    goBack: async () => {
      return { success: false };
    },
    goForward: async () => {
      return { success: false };
    },
    reload: async () => {
      return { success: false };
    },
    stop: async () => {
      return { success: false };
    },
    close: async () => {
      return { success: false };
    },
    getState: async () => {
      return { success: false, state: null };
    },
    attach: async () => {
      return { success: false };
    },
    detach: async () => {
      return { success: false };
    },
    setBounds: async () => {
      return { success: false };
    },
    focus: async () => {
      return { success: false };
    },
    getPersistedTabs: async () => {
      return { tabs: [] };
    },
  },

  // ========== Browser Control ==========
  browserControl: {
    getStatus: async () => {
      const { getBrowserControlStatus } = await import('../handlers/browserControl');
      return getBrowserControlStatus();
    },
    getPolicy: async () => {
      const { getBrowserControlPolicy } = await import('../handlers/browserControl');
      return getBrowserControlPolicy();
    },
    setPolicy: async ([policy]: [import('../../shared/browserAccessPolicy').BrowserAccessPolicy]) => {
      const { setBrowserControlPolicy } = await import('../handlers/browserControl');
      return setBrowserControlPolicy(policy);
    },
    arrangeSplit: async () => {
      return {
        success: false,
        error: 'Window arrangement is only available in the Interpreter desktop app.',
      };
    },
  },

  // ========== Background Opacity ==========
  backgroundOpacity: {
    get: async () => {
      const { getBackgroundOpacity } = await import('../handlers/settings');
      return getBackgroundOpacity();
    },
    set: async ([opacity]: [number]) => {
      const { setBackgroundOpacity } = await import('../handlers/settings');
      return setBackgroundOpacity(opacity);
    },
  },

  // ========== Zoom Factor ==========
  zoomFactor: {
    get: async () => {
      const { getZoomFactor } = await import('../handlers/settings');
      return getZoomFactor();
    },
    set: async ([zoomFactor]: [number]) => {
      const { setZoomFactor } = await import('../handlers/settings');
      return setZoomFactor(zoomFactor);
    },
  },

  // ========== Theme ==========
  theme: {
    get: async () => {
      const { getTheme } = await import('../handlers/settings');
      return getTheme();
    },
    set: async ([themeValue]: ['light' | 'dark' | 'system']) => {
      const { setTheme } = await import('../handlers/settings');
      return setTheme(themeValue);
    },
  },

  // ========== Primary Color ==========
  primaryColor: {
    get: async () => {
      const { getPrimaryColor } = await import('../handlers/settings');
      return getPrimaryColor();
    },
    set: async ([color]: [string]) => {
      const { setPrimaryColor } = await import('../handlers/settings');
      return setPrimaryColor(color);
    },
  },

  // ========== Agent Settings ==========
  agentSettings: {
    getMaxSteps: async () => {
      const { getMaxSteps } = await import('../handlers/settings');
      return getMaxSteps();
    },
    setMaxSteps: async ([maxSteps]: [number]) => {
      const { setMaxSteps } = await import('../handlers/settings');
      return setMaxSteps(maxSteps);
    },
    getMaxSubagentDepth: async () => {
      const { getMaxSubagentDepth } = await import('../handlers/settings');
      return getMaxSubagentDepth();
    },
    setMaxSubagentDepth: async ([depth]: [number]) => {
      const { setMaxSubagentDepth } = await import('../handlers/settings');
      return setMaxSubagentDepth(depth);
    },
    getAutoContinuationLimit: async () => {
      const { getAutoContinuationLimit } = await import('../handlers/settings');
      return getAutoContinuationLimit();
    },
    setAutoContinuationLimit: async ([limit]: [number]) => {
      const { setAutoContinuationLimit } = await import('../handlers/settings');
      return setAutoContinuationLimit(limit);
    },
  },

  // ========== UI Settings ==========
  uiSettings: {
    ...(() => {
      return Object.fromEntries(
        BOOLEAN_UI_SETTING_IDS.flatMap((id: string) => {
          const pascal = id.charAt(0).toUpperCase() + id.slice(1);
          return [
            [`get${pascal}`, async () => {
              const { getBooleanUISetting } = await import('../handlers/settings');
              return getBooleanUISetting(id as any);
            }],
            [`set${pascal}`, async ([enabled]: [boolean]) => {
              const { setBooleanUISetting } = await import('../handlers/settings');
              return setBooleanUISetting(id as any, enabled);
            }],
          ];
        })
      );
    })(),
  },

  // ========== Overlay Settings ==========
  overlaySettings: {
    get: async () => {
      const { getInterpreterOverlaySettings } = await import('../handlers/settings');
      return getInterpreterOverlaySettings();
    },
    set: async ([settings]: [import('../../apps/interpreter-overlay/shared/settings').InterpreterOverlaySettings]) => {
      const { setInterpreterOverlaySettings } = await import('../handlers/settings');
      return setInterpreterOverlaySettings(settings);
    },
    getPermissionStatus: async () => {
      const { getInterpreterOverlayPermissionStatus } = await import('../handlers/settings');
      return getInterpreterOverlayPermissionStatus();
    },
    requestAccessibilityPermission: async () => {
      const { requestInterpreterOverlayAccessibilityPermission } = await import('../handlers/settings');
      return requestInterpreterOverlayAccessibilityPermission();
    },
    requestScreenRecordingPermission: async () => {
      const { requestInterpreterOverlayScreenRecordingPermission } = await import('../handlers/settings');
      return requestInterpreterOverlayScreenRecordingPermission();
    },
    openAccessibilitySettings: async () => {
      const { openInterpreterOverlayAccessibilitySettings } = await import('../handlers/settings');
      return openInterpreterOverlayAccessibilitySettings();
    },
    openScreenRecordingSettings: async () => {
      const { openInterpreterOverlayScreenRecordingSettings } = await import('../handlers/settings');
      return openInterpreterOverlayScreenRecordingSettings();
    },
  },

  computerUseSetup: {
    ready: async () => {
      const { markComputerUseSetupReady } = await import('../computerUseSetupGate');
      markComputerUseSetupReady();
      return { success: true };
    },
    status: async ([requestId, status]: [
      string,
      {
        accessibilityGranted: boolean;
        screenRecordingGranted: boolean;
        screenRecordingStatus?: string;
      },
    ]) => {
      const { resolveComputerUsePermissionStatusRequest } = await import('../computerUseSetupGate');
      resolveComputerUsePermissionStatusRequest(requestId, status);
      return { success: true };
    },
  },

  // ========== MCP Settings ==========
  mcpSettings: {
    getAllowAgentAddTools: async () => {
      const { getAllowAgentAddTools } = await import('../handlers/settings');
      return getAllowAgentAddTools();
    },
    setAllowAgentAddTools: async ([allowed]: [boolean]) => {
      const { setAllowAgentAddTools } = await import('../handlers/settings');
      return setAllowAgentAddTools(allowed);
    },
    getAllowLocalMcpServers: async () => {
      const { getAllowLocalMcpServers } = await import('../handlers/settings');
      return getAllowLocalMcpServers();
    },
    setAllowLocalMcpServers: async ([allowed]: [boolean]) => {
      const { setAllowLocalMcpServers } = await import('../handlers/settings');
      return setAllowLocalMcpServers(allowed);
    },
  },

  // ========== Global Tools ==========
  globalTools: {
    list: async () => {
      const { listGlobalTools } = await import('../handlers/globalTools');
      return { tools: await listGlobalTools() };
    },
    get: async ([serverId]: [string]) => {
      const { getGlobalToolEnabled } = await import('../handlers/globalTools');
      return { enabled: await getGlobalToolEnabled(serverId) };
    },
    set: async ([serverId, enabled]: [string, boolean]) => {
      const { setGlobalToolEnabled } = await import('../handlers/globalTools');
      await setGlobalToolEnabled(serverId, enabled);
      return { success: true };
    },
  },

  // ========== Native Tools (Codex engine built-in tools) ==========
  nativeTools: {
    restart: async () => {
      const { restartCodexRuntime } = await import('../../src/lib/codex/service');
      restartCodexRuntime();
      return { success: true };
    },
    getNetworkAccess: async () => {
      const { getCodexNetworkAccess } = await import('../configStore');
      return { enabled: await getCodexNetworkAccess() };
    },
    setNetworkAccess: async ([enabled]: [boolean]) => {
      const { setCodexNetworkAccess } = await import('../configStore');
      const { restartCodexRuntime } = await import('../../src/lib/codex/service');
      await setCodexNetworkAccess(enabled);
      restartCodexRuntime();
      return { success: true };
    },
    getSandboxNetworkAccess: async () => {
      const { getSandboxNetworkAccess } = await import('../configStore');
      return { enabled: await getSandboxNetworkAccess() };
    },
    setSandboxNetworkAccess: async ([enabled]: [boolean]) => {
      const { setSandboxNetworkAccess } = await import('../configStore');
      await setSandboxNetworkAccess(enabled);
      return { success: true };
    },
    getApprovalPolicy: async () => {
      const { getCodexApprovalPolicy } = await import('../configStore');
      return { policy: await getCodexApprovalPolicy() };
    },
    setApprovalPolicy: async ([policy]: [string]) => {
      const { setCodexApprovalPolicy } = await import('../configStore');
      const { restartCodexRuntime } = await import('../../src/lib/codex/service');
      await setCodexApprovalPolicy(policy as 'never' | 'on-failure' | 'on-request' | 'untrusted');
      restartCodexRuntime();
      return { success: true };
    },
    getSandboxMode: async () => {
      const { getCodexSandboxMode } = await import('../configStore');
      return { mode: await getCodexSandboxMode() };
    },
    setSandboxMode: async ([mode]: [string]) => {
      const { setCodexSandboxMode } = await import('../configStore');
      const { restartCodexRuntime } = await import('../../src/lib/codex/service');
      await setCodexSandboxMode(mode as 'read-only' | 'workspace-write' | 'danger-full-access');
      restartCodexRuntime();
      return { success: true };
    },
    getReadAccessMode: async () => {
      const { getCodexReadAccessMode } = await import('../configStore');
      return { mode: await getCodexReadAccessMode() };
    },
    setReadAccessMode: async ([mode]: [string]) => {
      const { setCodexReadAccessMode } = await import('../configStore');
      const { restartCodexRuntime } = await import('../../src/lib/codex/service');
      await setCodexReadAccessMode(mode as 'workspace-only' | 'full-system');
      restartCodexRuntime();
      return { success: true };
    },
    getMacosTempAccess: async () => {
      const { getCodexMacosTempAccess } = await import('../configStore');
      return { enabled: await getCodexMacosTempAccess() };
    },
    setMacosTempAccess: async ([enabled]: [boolean]) => {
      const { setCodexMacosTempAccess } = await import('../configStore');
      const { restartCodexRuntime } = await import('../../src/lib/codex/service');
      await setCodexMacosTempAccess(enabled);
      restartCodexRuntime();
      return { success: true };
    },
    getMacosScreenshotAccess: async () => {
      const { getCodexMacosScreenshotAccess } = await import('../configStore');
      return { enabled: await getCodexMacosScreenshotAccess() };
    },
    setMacosScreenshotAccess: async ([enabled]: [boolean]) => {
      const { setCodexMacosScreenshotAccess } = await import('../configStore');
      const { restartCodexRuntime } = await import('../../src/lib/codex/service');
      await setCodexMacosScreenshotAccess(enabled);
      restartCodexRuntime();
      return { success: true };
    },
    getCuaAccessPolicy: async () => {
      const { getCuaAccessPolicy } = await import('../configStore');
      return { policy: await getCuaAccessPolicy() };
    },
    setCuaAccessPolicy: async ([policy]: [import('../../shared/cuaAccessPolicy').CuaAccessPolicy]) => {
      const { setCuaAccessPolicy } = await import('../configStore');
      return { success: true, policy: await setCuaAccessPolicy(policy) };
    },
    getApprovalAutoApproveForTests: async () => {
      if (process.env.NODE_ENV !== 'test') {
        throw new Error('getApprovalAutoApproveForTests is only available in test mode');
      }
      const { approvalManager } = await import('../approvalManager');
      return { enabled: approvalManager.isAutoApproveEnabled() };
    },
    setApprovalAutoApproveForTests: async ([enabled]: [boolean]) => {
      if (process.env.NODE_ENV !== 'test') {
        throw new Error('setApprovalAutoApproveForTests is only available in test mode');
      }
      const { approvalManager } = await import('../approvalManager');
      approvalManager.setAutoApprove(enabled);
      return { success: true };
    },
    setupWindowsSandbox: async ([mode]: ['elevated' | 'unelevated']) => {
      const { getCodexClient } = await import('../../src/lib/codex/service');
      const { SERVER_METHOD } = await import('../../src/lib/codex/protocol');

      const client = getCodexClient();
      await client.ensureConnected();

      let resolveCompletion: ((value: { success: boolean; error: string | null; mode: 'elevated' | 'unelevated' }) => void) | null = null;
      let rejectCompletion: ((reason?: unknown) => void) | null = null;

      const completion = new Promise<{ success: boolean; error: string | null; mode: 'elevated' | 'unelevated' }>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });

      const unsubscribe = client.subscribe((notification) => {
        if (notification.method !== SERVER_METHOD.windowsSandboxSetupCompleted) {
          return;
        }
        if (notification.params.mode !== mode) {
          return;
        }
        unsubscribe();
        resolveCompletion?.({
          success: notification.params.success,
          error: notification.params.error,
          mode: notification.params.mode,
        });
      });

      const timeout = setTimeout(() => {
        unsubscribe();
        rejectCompletion?.(new Error('Timed out waiting for Windows sandbox setup to finish'));
      }, 5 * 60 * 1000);

      try {
        const result = await client.windowsSandboxSetupStart({ mode });
        if (!result.started) {
          clearTimeout(timeout);
          unsubscribe();
          return {
            success: false,
            error: 'Windows sandbox setup did not start',
            mode,
          };
        }

        const completed = await completion;
        clearTimeout(timeout);
        return completed;
      } catch (error) {
        clearTimeout(timeout);
        unsubscribe();
        throw error;
      }
    },
  },

  // ========== Terminal ==========
  terminal: {
    create: async ([cwd]: [string?]) => {
      const { createSession } = await import('../handlers/terminal');
      return createSession(cwd);
    },
    write: async ([sessionId, data]: [string, string]) => {
      const { writeSession } = await import('../handlers/terminal');
      return writeSession(sessionId, data);
    },
    resize: async ([sessionId, cols, rows]: [string, number, number]) => {
      const { resizeSession } = await import('../handlers/terminal');
      return resizeSession(sessionId, cols, rows);
    },
    close: async ([sessionId]: [string]) => {
      const { closeSession } = await import('../handlers/terminal');
      return closeSession(sessionId);
    },
  },

  // ========== Skills ==========
  skills: {
    list: async ([request]: [import('../../shared/types/skill').SkillsListRequest?] = []) => {
      const { getSkills } = await import('../handlers/skills');
      return { success: true, data: await getSkills(request?.workspacePath) };
    },
    setEnabled: async ([request]: [import('../handlers/codex-generated-types/v2').SkillsConfigWriteParams]) => {
      const { writeSkillConfig } = await import('../handlers/skills');
      return { success: true, data: await writeSkillConfig(request) };
    },
    invalidateCache: async () => {
      const { invalidateSkillsCache } = await import('../handlers/skills');
      invalidateSkillsCache();
      return { success: true };
    },
    delete: async ([dirPath]: [string]) => {
      const { deleteSkillDir } = await import('../handlers/skills');
      const result = await deleteSkillDir(dirPath);
      if (result.success) {
        const { broadcastEvent } = await import('../handlers/broadcast');
        broadcastEvent('skills:changed', {});
      }
      return result;
    },
    reveal: async ([dirPath]: [string]) => {
      const { revealInFinder } = await import('../handlers/shell');
      return revealInFinder(dirPath);
    },
  },

  // ========== Skill Settings ==========
  skillSettings: {
    getFolders: async () => {
      const { getSkillFolders } = await import('../handlers/settings');
      return getSkillFolders();
    },
    setFolders: async ([folders]: [string[]]) => {
      const { setSkillFolders } = await import('../handlers/settings');
      return setSkillFolders(folders);
    },
    getAllowModelSkillEditing: async () => {
      const { getAllowModelSkillEditing } = await import('../handlers/settings');
      return getAllowModelSkillEditing();
    },
    getGlobalFolder: async () => {
      const { getGlobalSkillsRoot } = await import('../handlers/skills');
      return { folder: getGlobalSkillsRoot() };
    },
    setAllowModelSkillEditing: async ([allowed]: [boolean]) => {
      const { setAllowModelSkillEditing } = await import('../handlers/settings');
      return setAllowModelSkillEditing(allowed);
    },
  },

  // ========== Codex Server (COMMENTED OUT - Removed in model system redesign) ==========
  // codex: {
  //   request: async ([method, params]: [string, unknown]) => {
  //     const { send_request } = await import('../handlers/codexServer');
  //     return send_request(method, params);
  //   },
  //   save_thread: async ([thread_id, items]: [string, unknown[]]) => {
  //     const { save_thread } = await import('../handlers/codexServer');
  //     save_thread(thread_id, items);
  //     return { ok: true };
  //   },
  //   load_thread: async ([thread_id]: [string]) => {
  //     const { load_thread } = await import('../handlers/codexServer');
  //     return { items: load_thread(thread_id) };
  //   },
  //   list_threads: async () => {
  //     const { list_saved_threads } = await import('../handlers/codexServer');
  //     return { threads: list_saved_threads() };
  //   },
  // },
};

// ============================================================================
// Router Endpoint
// ============================================================================

router.post('/:namespace/:method', async (req: Request, res: Response) => {
  const { namespace, method } = req.params;
  const args = req.body || [];

  if (
    PRELAUNCH_SECURITY_DISABLE_HTTP_TOOL_EXECUTION &&
    namespace === 'servers' &&
    method === 'callTool'
  ) {
    return res.status(403).json({
      error: 'Tool execution over HTTP is disabled during pre-launch security hardening.',
    });
  }

  const namespaceHandlers = handlers[namespace];
  if (!namespaceHandlers) {
    return res.status(404).json({ error: `Unknown namespace: ${namespace}` });
  }

  const handler = namespaceHandlers[method];
  if (!handler) {
    return res.status(404).json({ error: `Unknown method: ${namespace}.${method}` });
  }

  try {
    const result = await handler(args);
    res.json(result);
  } catch (error: any) {
    const message = error?.message || 'Internal server error';
    const shouldSuppressExpectedError =
      namespace === 'providers'
      && method === 'listOpenAIOAuthModels'
      && error instanceof Error
      && error.message === 'OpenAI OAuth account is not connected';

    if (!shouldSuppressExpectedError) {
      const signature = `${namespace}.${method}:${message}`;
      const repeatCount = (ipcErrorRepeatCounts.get(signature) ?? 0) + 1;
      ipcErrorRepeatCounts.set(signature, repeatCount);

      if (repeatCount === 1) {
        console.error(`[IPC Router] Error in ${namespace}.${method}:`, error);
      } else if (repeatCount % 25 === 0) {
        console.warn(
          `[IPC Router] Repeated error namespace=${namespace} method=${method} count=${repeatCount} message=${JSON.stringify(message)}`,
        );
      }
    }
    res.status(500).json({ error: message });
  }
});

export default router;
