import { unwatchFile, watchFile } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, join as pathJoin, resolve } from "node:path";
import Conf from 'conf';
import { parse as parseToml, type TomlTable } from 'smol-toml';
import type { McpServerConfig, McpServerConnectionFailure } from "./tools/mcpTypes";
import type { Profile } from "../shared/types/profile";
import {
  BUILTIN_PROVIDERS,
  type Provider,
} from "../shared/types/provider";
import {
  getDefaultProfilesConfig,
  isBuiltinProfile,
  getBuiltinProfileDefaults,
} from "../shared/types/profile";
import { isValidPrimaryColor, PRIMARY_COLOR_IDS } from "../shared/types/colors";
import {
  DEFAULT_TTS_SETTINGS,
  getTtsModelById,
  TTS_PROVIDERS,
  type TtsSettings,
} from "../shared/types/tts";
import {
  STT_BACKENDS,
  DEFAULT_STT_SETTINGS,
  STT_MAX_FAST_SENTENCE_TIMEOUT_MS,
  STT_MAX_PREVIEW_BEFORE_SEND_MS,
  STT_MAX_SILENCE_TIMEOUT_MS,
  STT_MIN_FAST_SENTENCE_TIMEOUT_MS,
  STT_MIN_PREVIEW_BEFORE_SEND_MS,
  STT_MIN_SILENCE_TIMEOUT_MS,
  normalizeAmbientPhrases,
  type SttBackend,
  type SttSettings,
} from "../shared/types/stt";
import {
  isChineseLanguageCode,
  resolveEffectiveTranscriptLanguage,
} from "../shared/utils/sttTranscriptSanitizer";
import {
  DEFAULT_INTERPRETER_OVERLAY_SETTINGS,
  sanitizeInterpreterOverlaySettings,
  type InterpreterOverlaySettings,
} from "../apps/interpreter-overlay/shared/settings";
import { migrateConfig, CURRENT_CONFIG_VERSION } from "./configMigrations";
import type { SettingsSnapshot as SettingsSnapshotShape } from "./configSchema";
import {
  DEFAULT_AUTO_CONTINUATION_LIMIT,
  DEFAULT_BACKGROUND_OPACITY,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_SUBAGENT_DEPTH,
  applySettingsSnapshot,
  assertValidAppConfig,
  assertValidSettingsSnapshot,
  buildSettingsSnapshot,
} from "./settingsSnapshot";
import { normalizeCustomInstructions } from './utils/customInstructions';
import {
  clearInMemoryModelConfigState,
  createHostedFallbackModelConfigState,
  createDefaultModelConfigState,
  extractModelConfigState,
  getBuiltinProvider,
  hasLegacyModelConfigFields,
  loadModelConfigStateWithIssues,
  mergeModelConfigState,
  repairModelConfigState,
  saveModelConfigState,
  stripLegacyModelConfigFields,
  type ModelConfigState,
} from './modelConfigTomlStore';
import { broadcastEvent } from './handlers/broadcast';
import { IPC_CHANNELS } from '../electron/ipc/registry';
import {
  DEFAULT_BROWSER_ACCESS_POLICY,
  normalizeBrowserAccessPolicy,
  type BrowserAccessPolicy,
} from '../shared/browserAccessPolicy';
import {
  DEFAULT_CUA_ACCESS_POLICY,
  normalizeCuaAccessPolicy,
  type CuaAccessPolicy,
} from '../shared/cuaAccessPolicy';
import {
  createDefaultOnboardingState,
  type OnboardingState,
} from '../shared/types/onboardingState';
import {
  resolveInterpreterConfigFile,
  resolveInterpreterDataDir,
  resolveLegacyInterpreterConfigFile,
} from '../shared/interpreterConfigPaths';
import { getCodexClient } from './utils/codexServiceBridge';
import { migrateLegacyMcpOAuthToCodex } from './utils/legacyMcpOAuthMigration';

// Re-export MCP types for convenience
export type { McpServerConfig, McpServerConnectionFailure };

export interface AgentConfig {
  selectedAuthMethod?: string;
  apiKeys?: Record<string, string>; // methodId -> API key
  authenticated?: boolean;
  oauthEmail?: string; // For display in settings
  lastAuthenticatedAt?: number; // Timestamp
  googleCloudProject?: string; // For Workspace/GCA accounts (gemini-cli specific)
}

export interface RecentFolder {
  path: string;
  name: string;
  lastOpened: number; // timestamp
}

export interface AppConfig {
  configVersion?: number; // Schema version for migrations (see configMigrations.ts)
  defaultAgent?: string; // agent ID
  agents: Record<string, AgentConfig>; // agentId -> config
  mcpServers?: Record<string, McpServerConfig>; // serverId -> config
  builtinToolsEnabled?: Record<string, boolean>; // builtinServerId -> enabled state
  profiles?: Profile[]; // Merged model profiles view (persisted in codex-home/config.toml)
  defaultProfileId?: string; // Last selected profile for new agents (persisted in codex-home/config.toml)
  fastProfileId?: string; // Global fast profile used by subagent tooling (persisted in codex-home/config.toml)
  providers?: Record<string, Provider>; // Merged provider view (persisted in codex-home/config.toml)
  backgroundOpacity?: number; // Background opacity (0-1 range)
  zoomFactor?: number; // Interface zoom factor (0.5-3 range)
  theme?: 'light' | 'dark' | 'system'; // Theme preference
  primaryColor?: string; // Primary accent color (e.g., "blue", "purple")
  lastWorkspace?: string | null; // Last opened workspace path
  recentFolders?: RecentFolder[]; // Recent workspace folders

  // Auth tokens for CI/test bootstrapping
  // Primary auth is handled by Supabase localStorage in the frontend.
  // These tokens are written here as a fallback for:
  // 1. CI environments that pre-populate config before running tests
  // 2. Sharing auth between different Electron instances (main app vs test app)
  // On startup, if no Supabase session exists in localStorage, the app
  // will attempt to bootstrap from these tokens.
  authToken?: string;
  refreshToken?: string;

  // Agent settings
  maxSteps?: number; // Maximum tool call steps per agent task (default: 1000)
  maxSubagentDepth?: number; // Maximum subagent nesting depth (default: 5)
  autoContinuationLimit?: number; // Maximum task-list auto-continuations per conversation (default: 10)
  customInstructions?: string; // Persistent user instructions injected into Codex developer instructions

  // Global disabled tools (MCPs in this list are disabled for all agents)
  globalDisabledTools?: string[];
  // Codex native tools sandbox network access (default: true)
  codexNetworkAccess?: boolean;
  // Codex approval policy (default: "never")
  codexApprovalPolicy?: 'never' | 'on-failure' | 'on-request' | 'untrusted';
  // Codex sandbox mode (default: "workspace-write")
  codexSandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  // Codex read access scope (default: "full-system")
  codexReadAccessMode?: 'workspace-only' | 'full-system';
  // Codex macOS temp folder access (default: true)
  codexMacosTempAccess?: boolean;
  // Codex macOS screenshot staging access (default: true)
  codexMacosScreenshotAccess?: boolean;
  // MCP sandboxed bash tool network access (default: false)
  sandboxNetworkAccess?: boolean;
  // Browser page access policy
  browserAccessPolicy?: BrowserAccessPolicy;
  // Native Computer Use app access policy
  cuaAccessPolicy?: CuaAccessPolicy;

  // UI settings
  showHelpPanelPreview?: boolean; // Show file preview in help panel (default: false)
  reviewMarkdownEdits?: boolean; // Show accept/reject UI when agents edit markdown files (default: true)
  launchAtLogin?: boolean; // Launch the app when user logs into the OS (default: false)
  whatsNewDismissed?: boolean; // Whether the "What's new" video has been dismissed
  dismissedTopNoticeVersions?: Record<string, string>; // Per-notice dismissed versions for top-of-page notices
  lastDismissedReleaseNotesVersion?: number | string; // RELEASE_NOTES_VERSION string the user last dismissed (legacy: number)
  lastDismissedInterviewInviteVersion?: string; // INTERVIEW_INVITE_VERSION string the user last dismissed
  dismissedAutomaticProfileIds?: string[]; // Automatic profiles the user explicitly removed
  appLaunchCount?: number; // Number of completed app launches
  lastMigrationVersion?: number; // Most recent config version migrated by this app launch
  lastMigrationBackupPath?: string; // Path to pre-migration config backup file
  lastMigrationUnsupportedProfiles?: Array<{
    profileId: string;
    profileName: string;
    field: 'modelId' | 'fastModel' | 'visionModel';
    previousModelId: string;
  }>;
  lastMigrationDeprecatedProfiles?: Array<{
    profileId: string;
    profileName: string;
    provider: string;
    reason: string;
  }>;

  // User info (set during onboarding)
  userName?: string; // User's display name

  // Question/Approval settings
  questionAutoTimeoutEnabled?: boolean; // Allow auto-timeout on optional questions (default: true)
  questionAutoTimeoutSeconds?: number; // Countdown duration in seconds (default: 15)
  autoApproveLowRiskMediaCards?: boolean; // Allow configured low-risk media permission cards to auto-approve (default: false)

  // Privacy settings (set during onboarding)
  telemetryEnabled?: boolean; // Whether to share anonymous usage analytics
  deviceId?: string; // Anonymous device identifier for telemetry (UUID)

  // Onboarding: user email (from Stay Connected screen)
  userEmail?: string;

  // Onboarding: explicit durable state for first-run and setup flows.
  onboardingState?: OnboardingState;

  // Onboarding: derived persona from silent environment detection
  onboardingPersona?: {
    bucket: 'non-developer' | 'developer' | 'developer-local-ai';
    subCategories: string[];             // e.g., ['frontend-dev', '3d-artist']
    detectedProviders: string[];         // e.g., ['openai-key', 'anthropic-key', 'ollama']
  };

  // Custom binary paths
  claudeCodePath?: string; // Custom path to Claude Code CLI binary
  codexPath?: string; // Custom path to Codex CLI binary

  // MCP/Tool settings
  allowAgentAddTools?: boolean; // Allow agent to add tools from the store (default: true)
  allowLocalMcpServers?: boolean; // Allow local/stdio MCP servers (default: false, advanced)

  // Skills settings
  skillFolders?: string[]; // Custom skill folder paths (in addition to default locations)
  allowModelSkillEditing?: boolean; // Allow model to write to the skills folder (default: false)

  // Interpreter Overlay settings
  interpreterOverlay?: InterpreterOverlaySettings;

  // i18n
  language?: string; // User's preferred UI language (e.g., 'en', 'zh-CN', 'ja', 'es', 'ko')

  // Text-to-speech settings
  tts?: TtsSettings;
  // Speech-to-text settings
  stt?: SttSettings;
}

export type SettingsSnapshot = SettingsSnapshotShape;

const INTERPRETER_USER_DATA_DIR_ENV = "INTERPRETER_USER_DATA_DIR";
const INTERPRETER_HOME_ENV = "INTERPRETER_HOME";
const CODEX_HOME_ENV = "CODEX_HOME";
const LEGACY_CONFIG_FILE = resolveLegacyInterpreterConfigFile();

export const configStoreFs = {
  access,
  copyFile,
  mkdir,
  rename,
  unlink,
};

let store: Conf<AppConfig> | null = null;
let watchedConfigFilePath: string | null = null;

let overrideConfig: AppConfig | null = null; // For testing
let migrationDone = false;
let modelConfigMigrationDone = false;

function stripLegacyRootFilePermissionFields(config: AppConfig): AppConfig {
  const nextConfig = config as AppConfig & {
    filePermissions?: unknown;
    permissions?: unknown;
  };

  if (!('filePermissions' in nextConfig) && !('permissions' in nextConfig)) {
    return config;
  }

  const cleanedConfig = { ...nextConfig };
  delete cleanedConfig.filePermissions;
  delete cleanedConfig.permissions;
  return cleanedConfig;
}
let migrationPromise: Promise<void> | null = null;

export function getInterpreterHomeDir(): string {
  return resolveInterpreterDataDir();
}

function getConfigFilePath(): string {
  return resolveInterpreterConfigFile();
}

function stopConfigFileWatcher(): void {
  if (!watchedConfigFilePath) return;
  unwatchFile(watchedConfigFilePath);
  watchedConfigFilePath = null;
}

// NOTE(victor): conf v15.0.0's `watch: true` is a directory fs.watch with no 'error' listener,
// so async watcher failures (e.g. EMFILE broadcast by libuv's shared FSEventStream on
// macOS) crash the process as uncaught exceptions. Stat-polling fs.watchFile (conf's own
// v10-v14 macOS behavior) has no fds, no FSEvents, and no 'error' event to leave unhandled.
function startConfigFileWatcher(): void {
  watchedConfigFilePath = getConfigFilePath();
  watchFile(watchedConfigFilePath, { persistent: false, interval: 1000 }, () => {
    migrationDone = false;
  });
}

function createConfigStore(): Conf<AppConfig> {
  const nextStore = new Conf<AppConfig>({
    cwd: getInterpreterHomeDir(),
    configName: 'config',
    serialize: (value: AppConfig) => JSON.stringify(value, null, 2),
    accessPropertiesByDotNotation: false,
    clearInvalidConfig: true,
  });

  startConfigFileWatcher();

  return nextStore;
}

function getStore(): Conf<AppConfig> {
  if (!store) {
    store = createConfigStore();
  }
  return store;
}

function resetConfigStore(): void {
  stopConfigFileWatcher();
  store = null;
  migrationDone = false;
  migrationPromise = null;
  modelConfigMigrationDone = false;
  clearInMemoryModelConfigState();
}

function readStoreValue<K extends keyof AppConfig>(key: K): AppConfig[K] | undefined {
  try {
    return getStore().get(key as string) as AppConfig[K] | undefined;
  } catch {
    return undefined;
  }
}

function readStoreConfigSync(): AppConfig {
  try {
    return getStore().store;
  } catch {
    return createDefaultConfig();
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await configStoreFs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function deleteLegacyConfigFile(): Promise<void> {
  try {
    await configStoreFs.unlink(LEGACY_CONFIG_FILE);
    console.log(`[ConfigStore] Deleted legacy config file at ${LEGACY_CONFIG_FILE}`);
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      console.warn(`[ConfigStore] Could not delete legacy config file: ${err.message}`);
    }
  }
}

function isFileNotFoundError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'ENOENT');
}

function trackLegacyConfigFileMigration(): void {
  import('./telemetry').then(({ clearTelemetryCache, trackFeatureUsed }) => {
    clearTelemetryCache();
    trackFeatureUsed('legacy_config_json_file_migrated_to_user_data').catch(() => {});
  }).catch(() => {});
}

async function migrateLegacyConfigFile(): Promise<void> {
  const configDir = getInterpreterHomeDir();
  const configFile = getConfigFilePath();

  if (configFile === LEGACY_CONFIG_FILE) {
    return;
  }

  if (!await pathExists(LEGACY_CONFIG_FILE)) {
    return;
  }

  await configStoreFs.mkdir(configDir, { recursive: true });

  if (!await pathExists(configFile)) {
    try {
      await configStoreFs.rename(LEGACY_CONFIG_FILE, configFile);
    } catch (err: any) {
      if (isFileNotFoundError(err)) {
        return;
      }

      if (err?.code !== 'EXDEV') {
        throw err;
      }

      // NOTE(victor): rename() cannot cross filesystems. Copy + delete keeps first
      // NOTE(victor): launch working when userData is on a different mount than ~/.interpreter.
      try {
        await configStoreFs.copyFile(LEGACY_CONFIG_FILE, configFile);
      } catch (copyErr) {
        if (isFileNotFoundError(copyErr)) {
          return;
        }
        throw copyErr;
      }
      await deleteLegacyConfigFile();
    }
    console.log(`[ConfigStore] Migrated config file to ${configFile}`);
    trackLegacyConfigFileMigration();
    return;
  }

  try {
    await configStoreFs.copyFile(LEGACY_CONFIG_FILE, configFile);
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return;
    }
    throw err;
  }
  console.log(`[ConfigStore] Imported legacy config file into ${configFile}`);
  trackLegacyConfigFileMigration();
  await deleteLegacyConfigFile();
}

async function ensureMigrated(): Promise<void> {
  if (migrationDone) return;
  if (migrationPromise) {
    await migrationPromise;
    return;
  }

  migrationDone = true;

  migrationPromise = (async () => {
    try {
      await migrateLegacyConfigFile();

      let config: AppConfig;
      let currentStore: Conf<AppConfig> | null = null;
      let storePath = getConfigFilePath();
      try {
        currentStore = getStore();
        storePath = currentStore.path;
        config = currentStore.store;
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
          throw new SyntaxError('Config file does not contain a valid JSON object');
        }
      } catch (err: any) {
        if (err?.code !== 'ENOENT') {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const backupPath = `${storePath}.invalid-${timestamp}`;
          try {
            await configStoreFs.copyFile(storePath, backupPath);
            console.warn(`[ConfigStore] Config invalid JSON: ${err.message}. Backup saved to: ${backupPath}`);
          } catch {
            console.warn(`[ConfigStore] Config invalid JSON: ${err.message}. Could not create backup.`);
          }
        }
        try {
          if (currentStore) {
            currentStore.store = createDefaultConfig();
          }
        } catch (writeErr: any) {
          console.warn(`[ConfigStore] Could not write new config file: ${writeErr.message}. Using in-memory defaults.`);
        }
        return;
      }

      const needsMigration = (config.configVersion ?? 0) < CURRENT_CONFIG_VERSION;
      let migrationBackupPath: string | undefined;
      if (needsMigration) {
        migrationBackupPath = `${storePath}.pre-migration-v${CURRENT_CONFIG_VERSION}`;
        try {
          await configStoreFs.copyFile(storePath, migrationBackupPath);
          console.log(`[ConfigStore] Pre-migration backup: ${migrationBackupPath}`);
        } catch { /* best-effort */ }
      }

      const wasMigrated = migrateConfig(config);
      const mcpOAuthMigration = await migrateLegacyMcpOAuthToCodex(config as AppConfig & { mcpOAuth?: unknown });
      if (wasMigrated && migrationBackupPath) {
        config.lastMigrationBackupPath = migrationBackupPath;
      }
      const wasRepaired = repairBuiltins(config);
      if (wasMigrated || wasRepaired || mcpOAuthMigration.changed) {
        currentStore.store = config;
        if (mcpOAuthMigration.changed && mcpOAuthMigration.migratedLegacyUrls.length > 0) {
          console.log(
            `[ConfigStore] Migrated ${mcpOAuthMigration.migratedLegacyUrls.length} legacy MCP OAuth entr${mcpOAuthMigration.migratedLegacyUrls.length === 1 ? 'y' : 'ies'} into Codex fallback credentials.`,
          );
        }
        let saveReason = 'updated';
        if (wasMigrated) {
          saveReason = 'migrated';
        } else if (wasRepaired) {
          saveReason = 'repaired';
        }
        console.log(`[ConfigStore] Config ${saveReason} and saved.`);
      }
    } catch (err) {
      migrationDone = false;
      throw err;
    } finally {
      migrationPromise = null;
    }
  })();

  await migrationPromise;
}

/**
 * Create a fresh valid config.
 * New users start with zero model profiles.
 */
function createDefaultConfig(): AppConfig {
  // Build providers record from builtins
  const providers: Record<string, Provider> = {};
  for (const p of BUILTIN_PROVIDERS) {
    providers[p.id] = p;
  }

  return {
    configVersion: CURRENT_CONFIG_VERSION,
    agents: {},
    backgroundOpacity: DEFAULT_BACKGROUND_OPACITY,
    zoomFactor: 1,
    primaryColor: 'gray',
    profiles: [],
    providers,
    tts: { ...DEFAULT_TTS_SETTINGS },
    stt: { ...DEFAULT_STT_SETTINGS, backend: getDefaultSttBackendForPlatform() },
    // No defaultProfileId — selected lazily after onboarding.
  };
}

function getDefaultSttBackendForPlatform(): SttBackend {
  return process.platform === 'win32' ? 'moonshine' : 'qwen';
}

function hasValidTtsSettings(settings: TtsSettings | undefined): settings is TtsSettings {
  if (!settings) return false;
  if (!getTtsModelById(settings.modelId)) return false;
  if (!(TTS_PROVIDERS as readonly string[]).includes(settings.provider)) return false;
  if (!Number.isInteger(settings.voiceId) || settings.voiceId < 0) return false;
  if (!Number.isFinite(settings.speed) || settings.speed <= 0) return false;
  if (!Number.isFinite(settings.pitch) || settings.pitch < -5 || settings.pitch > 5) return false;
  if (typeof settings.readAssistantMessages !== 'boolean') return false;
  if (typeof settings.autotuneEnabled !== 'boolean') return false;
  if (typeof settings.voiceResetEnabled !== 'boolean') return false;
  if (typeof settings.voiceResetPhrase !== 'string' || !settings.voiceResetPhrase.trim()) return false;
  return true;
}

function applyModelConfigState(config: AppConfig, state: ReturnType<typeof extractModelConfigState>): void {
  config.profiles = state.profiles;
  config.providers = state.providers;

  if (state.defaultProfileId) {
    config.defaultProfileId = state.defaultProfileId;
  } else {
    delete config.defaultProfileId;
  }

  if (state.fastProfileId) {
    config.fastProfileId = state.fastProfileId;
  } else {
    delete config.fastProfileId;
  }
}

function repairModelConfigFields(config: AppConfig): boolean {
  const state = extractModelConfigState(config);
  const modified = repairModelConfigState(state);
  applyModelConfigState(config, state);
  return modified;
}

/**
 * Repair config by ensuring required defaults and canonical builtin providers.
 * Returns true if config was modified, false if already valid.
 */
function repairBuiltins(config: AppConfig): boolean {
  let modified = false;

  if (!config.agents) {
    config.agents = {};
    modified = true;
  }

  // Migration: Initialize global disabled tools if not set
  if (!config.globalDisabledTools) {
    config.globalDisabledTools = [];
    modified = true;
  }

  // Migration: Initialize TTS settings if not set
  if (!config.tts) {
    config.tts = { ...DEFAULT_TTS_SETTINGS };
    modified = true;
  } else {
    const hasValidModel = !!getTtsModelById(config.tts.modelId);
    const hasValidProvider = (TTS_PROVIDERS as readonly string[]).includes(config.tts.provider);
    const hasValidVoice = Number.isInteger(config.tts.voiceId) && config.tts.voiceId >= 0;
    const hasValidSpeed = Number.isFinite(config.tts.speed) && config.tts.speed > 0;
    const hasValidPitch = Number.isFinite(config.tts.pitch) && config.tts.pitch >= -5 && config.tts.pitch <= 5;
    const hasValidReadAssistantMessages = typeof config.tts.readAssistantMessages === 'boolean';
    const hasValidAutotuneEnabled = typeof config.tts.autotuneEnabled === 'boolean';

    if (
      !hasValidModel
      || !hasValidProvider
      || !hasValidVoice
      || !hasValidSpeed
      || !hasValidPitch
      || !hasValidReadAssistantMessages
      || !hasValidAutotuneEnabled
    ) {
      config.tts = { ...DEFAULT_TTS_SETTINGS };
      modified = true;
    }

    // Migration: Add voice reset fields if missing
    if (typeof config.tts.voiceResetEnabled !== 'boolean') {
      config.tts.voiceResetEnabled = DEFAULT_TTS_SETTINGS.voiceResetEnabled;
      modified = true;
    }
    if (typeof config.tts.voiceResetPhrase !== 'string' || !config.tts.voiceResetPhrase.trim()) {
      config.tts.voiceResetPhrase = DEFAULT_TTS_SETTINGS.voiceResetPhrase;
      modified = true;
    }
  }

  if (!config.stt) {
    config.stt = { ...DEFAULT_STT_SETTINGS, backend: getDefaultSttBackendForPlatform() };
    modified = true;
  } else {
    const hasValidBackend = (STT_BACKENDS as readonly string[]).includes(config.stt.backend);
    const hasValidSilenceTimeout = Number.isFinite(config.stt.silenceTimeoutMs)
      && config.stt.silenceTimeoutMs >= STT_MIN_SILENCE_TIMEOUT_MS
      && config.stt.silenceTimeoutMs <= STT_MAX_SILENCE_TIMEOUT_MS;
    const hasValidFastSentenceTimeout = Number.isFinite(config.stt.fastSentenceSilenceTimeoutMs)
      && config.stt.fastSentenceSilenceTimeoutMs >= STT_MIN_FAST_SENTENCE_TIMEOUT_MS
      && config.stt.fastSentenceSilenceTimeoutMs <= STT_MAX_FAST_SENTENCE_TIMEOUT_MS;
    const hasValidPreviewDelay = Number.isFinite(config.stt.previewBeforeSendMs)
      && config.stt.previewBeforeSendMs >= STT_MIN_PREVIEW_BEFORE_SEND_MS
      && config.stt.previewBeforeSendMs <= STT_MAX_PREVIEW_BEFORE_SEND_MS;
    const hasValidWindowsBackend = process.platform !== 'win32' || config.stt.backend === 'moonshine';

    if (!hasValidBackend || !hasValidSilenceTimeout || !hasValidFastSentenceTimeout || !hasValidPreviewDelay || !hasValidWindowsBackend) {
      config.stt = { ...DEFAULT_STT_SETTINGS, backend: getDefaultSttBackendForPlatform() };
      modified = true;
    }
    if (typeof config.stt.stripChineseCharacters !== 'boolean') {
      config.stt.stripChineseCharacters = DEFAULT_STT_SETTINGS.stripChineseCharacters;
      modified = true;
    }
    if ('interimIntervalMs' in config.stt) {
      delete (config.stt as Record<string, unknown>).interimIntervalMs;
      modified = true;
    }
    const resolvedStripChineseCharacters = resolveStripChineseCharactersForLanguage(
      config.stt.stripChineseCharacters,
      config.language ?? null,
    );
    if (config.stt.stripChineseCharacters !== resolvedStripChineseCharacters) {
      config.stt.stripChineseCharacters = resolvedStripChineseCharacters;
      modified = true;
    }
  }

  if (hasLegacyModelConfigFields(config)) {
    modified = repairModelConfigFields(config) || modified;
  }

  return modified;
}

export async function getSettingsSnapshot(): Promise<SettingsSnapshot> {
  const config = await loadConfig();
  return buildSettingsSnapshot(config);
}

export async function saveSettingsSnapshot(snapshot: SettingsSnapshot): Promise<void> {
  const validatedSnapshot = assertValidSettingsSnapshot(snapshot);
  const config = await loadConfig();
  const nextConfig = applySettingsSnapshot(config, validatedSnapshot);
  await saveConfig(assertValidAppConfig(nextConfig));
}

async function updateSettingsSnapshot(
  updater: (snapshot: SettingsSnapshot) => SettingsSnapshot,
): Promise<void> {
  const currentSnapshot = await getSettingsSnapshot();
  await saveSettingsSnapshot(updater(currentSnapshot));
}

export async function loadConfig(): Promise<AppConfig> {
  if (overrideConfig) return overrideConfig;
  await ensureMigrated();
  try {
    const config = getStore().store;
    const cleanedConfig = stripLegacyRootFilePermissionFields(config);
    if (cleanedConfig !== config) {
      getStore().store = cleanedConfig;
    }
    return cleanedConfig;
  } catch {
    return createDefaultConfig();
  }
}

async function loadConfigForRead(fallbackReason: string): Promise<AppConfig> {
  try {
    return await loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[ConfigStore] Could not load config for ${fallbackReason}: ${message}. Using in-memory defaults.`);
    return createDefaultConfig();
  }
}

async function ensureModelConfigMigrated(baseConfig?: AppConfig): Promise<void> {
  if (overrideConfig || modelConfigMigrationDone) return;

  const config = baseConfig ?? await loadConfig();
  if (!hasLegacyModelConfigFields(config)) {
    modelConfigMigrationDone = true;
    return;
  }

  await saveModelConfigState(extractModelConfigState(config));
  getStore().store = stripLegacyModelConfigFields(config);
  modelConfigMigrationDone = true;
}

function resolveModelConfigTomlPath(): string {
  return pathJoin(resolveInterpreterDataDir(), 'codex-home', 'config.toml');
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveStripChineseCharactersForLanguage(
  stripChineseCharacters: boolean,
  language: string | null | undefined,
): boolean {
  if (isChineseLanguageCode(resolveEffectiveTranscriptLanguage(language))) {
    return false;
  }

  return stripChineseCharacters;
}

const RESERVED_LOCAL_PROVIDER_IDS = new Set(['ollama', 'lmstudio']);

function isReservedLocalProviderCollisionError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes('model_providers')
    && message.includes('reserved built-in provider ids');
}

function isModelProvidersValidationError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes('invalid configuration')
    && message.includes('model_providers')
    && message.includes('in `model_providers');
}

function isLikelyInvalidModelConfigFileError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes('failed to read configuration layers')
    || (message.includes('config.toml') && message.includes('invalid configuration'))
    || (message.includes('config.toml') && message.includes('toml'))
    || isModelProvidersValidationError(error)
    || isReservedLocalProviderCollisionError(error);
}

async function repairReservedLocalProviderOverrides(filePath: string): Promise<boolean> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return false;
  }

  let parsed: TomlTable;
  try {
    parsed = parseToml(content);
  } catch {
    return false;
  }

  const modelProviders = parsed.model_providers;
  if (!modelProviders || typeof modelProviders !== 'object' || Array.isArray(modelProviders)) {
    return false;
  }

  let modified = false;
  try {
    for (const providerId of RESERVED_LOCAL_PROVIDER_IDS) {
      if (Object.prototype.hasOwnProperty.call(modelProviders, providerId)) {
        await getCodexClient().configValueWrite(`model_providers.${providerId}`, null);
        modified = true;
      }
    }
  } catch {
    return false;
  }

  if (!modified) {
    return false;
  }
  return true;
}

async function backupModelConfigFile(filePath: string): Promise<string | null> {
  try {
    await access(filePath);
  } catch {
    return null;
  }

  const backupPath = buildTimestampedModelConfigBackupPath(filePath);
  try {
    await copyFile(filePath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}

function buildTimestampedModelConfigBackupPath(filePath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const extension = extname(filePath);
  const fileName = basename(filePath, extension);
  return pathJoin(dirname(filePath), `${fileName}.${timestamp}${extension}`);
}

async function moveInvalidModelConfigFileAside(filePath: string): Promise<string | null> {
  try {
    await access(filePath);
  } catch {
    return null;
  }

  const backupPath = buildTimestampedModelConfigBackupPath(filePath);

  try {
    await rename(filePath, backupPath);
    return backupPath;
  } catch {}

  try {
    await copyFile(filePath, backupPath);
    await unlink(filePath);
    return backupPath;
  } catch {
    return null;
  }
}

function emitModelConfigRecoveryEvent(filePath: string, backupPath: string | null, issues: string[]): void {
  broadcastEvent(IPC_CHANNELS.PROFILES_CONFIG_RECOVERED, {
    filePath,
    backupPath,
    issues,
  });
}

type ModelConfigLoadRecoveryEvent = {
  filePath: string;
  backupPath: string | null;
  issues: string[];
};

type ModelConfigLoadResult = {
  state: ModelConfigState;
  recoveryEvent: ModelConfigLoadRecoveryEvent | null;
  authCredentialsMissing: boolean;
};

async function persistRecoveredModelConfigState(
  state: ModelConfigState,
  label: 'recovered' | 'repaired',
): Promise<string | null> {
  try {
    await saveModelConfigState(state);
    return null;
  } catch (error) {
    const message = getErrorMessage(error);
    console.warn(
      `[ConfigStore] Could not persist ${label} model configuration during read recovery: ${message}. Using in-memory state for this session.`,
    );
    return `Could not persist the ${label} model configuration during read recovery: ${message}. Using in-memory state for this session.`;
  }
}

async function buildRecoveredModelConfigLoadResult(error: unknown): Promise<ModelConfigLoadResult> {
  const filePath = resolveModelConfigTomlPath();
  const backupPath = await moveInvalidModelConfigFileAside(filePath);
  const issue = `Reset an unreadable model configuration file: ${getErrorMessage(error)}`;
  const state = createHostedFallbackModelConfigState();
  const persistenceIssue = await persistRecoveredModelConfigState(state, 'recovered');
  const issues = persistenceIssue ? [issue, persistenceIssue] : [issue];

  return {
    state,
    recoveryEvent: {
      filePath,
      backupPath,
      issues,
    },
    authCredentialsMissing: persistenceIssue !== null,
  };
}

async function buildLoadedModelConfigResult(): Promise<ModelConfigLoadResult> {
  const loadedModelConfig = await loadModelConfigStateWithIssues();
  if (loadedModelConfig.issues.length === 0) {
    return {
      state: loadedModelConfig.state,
      recoveryEvent: null,
      authCredentialsMissing: loadedModelConfig.authCredentialsMissing,
    };
  }

  const filePath = loadedModelConfig.filePath ?? resolveModelConfigTomlPath();
  const backupPath = await backupModelConfigFile(filePath);
  const persistenceIssue = await persistRecoveredModelConfigState(loadedModelConfig.state, 'repaired');
  const issues = persistenceIssue
    ? [...loadedModelConfig.issues, persistenceIssue]
    : loadedModelConfig.issues;
  return {
    state: loadedModelConfig.state,
    recoveryEvent: {
      filePath,
      backupPath,
      issues,
    },
    authCredentialsMissing: persistenceIssue !== null && loadedModelConfig.authCredentialsMissing,
  };
}

async function loadModelConfigResultWithRecovery(): Promise<ModelConfigLoadResult> {
  try {
    return await buildLoadedModelConfigResult();
  } catch (error) {
    if (isReservedLocalProviderCollisionError(error) && await repairReservedLocalProviderOverrides(resolveModelConfigTomlPath())) {
      try {
        return await buildLoadedModelConfigResult();
      } catch (retryError) {
        if (!isLikelyInvalidModelConfigFileError(retryError)) {
          throw retryError;
        }
        return await buildRecoveredModelConfigLoadResult(retryError);
      }
    }

    if (!isLikelyInvalidModelConfigFileError(error)) {
      throw error;
    }
    return await buildRecoveredModelConfigLoadResult(error);
  }
}

async function buildConfigWithModelState(baseConfig: AppConfig): Promise<AppConfig> {
  await ensureModelConfigMigrated(baseConfig);
  const { state: modelState, recoveryEvent, authCredentialsMissing } = await loadModelConfigResultWithRecovery();

  const mergedConfig = mergeModelConfigState(
    baseConfig as unknown as Record<string, unknown>,
    modelState,
  ) as unknown as AppConfig;

  if (repairModelConfigFields(mergedConfig) || authCredentialsMissing) {
    try {
      await saveConfig(mergedConfig);
    } catch (error) {
      // NOTE(victor): write during config load is best-effort; file may be locked or unwritable
      console.warn('configStore: best-effort save during config load failed, ok=false', error instanceof Error ? error.message : error);
    }
  }

  if (recoveryEvent) {
    emitModelConfigRecoveryEvent(recoveryEvent.filePath, recoveryEvent.backupPath, recoveryEvent.issues);
  }

  return mergedConfig;
}

export async function loadConfigWithModelState(): Promise<AppConfig> {
  if (overrideConfig) return overrideConfig;
  const baseConfig = await loadConfig();

  try {
    return await buildConfigWithModelState(baseConfig);
  } catch (error) {
    if (isReservedLocalProviderCollisionError(error)) {
      if (await repairReservedLocalProviderOverrides(resolveModelConfigTomlPath())) {
        return await buildConfigWithModelState(baseConfig);
      }
      const { state: modelState, recoveryEvent } = await buildRecoveredModelConfigLoadResult(error);
      const mergedConfig = mergeModelConfigState(
        baseConfig as unknown as Record<string, unknown>,
        modelState,
      ) as unknown as AppConfig;

      if (repairModelConfigFields(mergedConfig)) {
        await saveConfig(mergedConfig);
      }

      if (recoveryEvent) {
        emitModelConfigRecoveryEvent(recoveryEvent.filePath, recoveryEvent.backupPath, recoveryEvent.issues);
      }

      return mergedConfig;
    }
    throw error;
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  const cleanedConfig = stripLegacyRootFilePermissionFields(config);

  if (overrideConfig) {
    overrideConfig = cleanedConfig;
    return;
  }

  const hasModelFields = hasLegacyModelConfigFields(cleanedConfig);
  if (!hasModelFields || !modelConfigMigrationDone) {
    getStore().store = cleanedConfig;
    return;
  }

  getStore().store = stripLegacyModelConfigFields(cleanedConfig);

  await saveModelConfigState(extractModelConfigState(cleanedConfig));
  modelConfigMigrationDone = true;
}

export function getConfigPath(): string {
  return getStore().path;
}

export function setInterpreterHomeDir(homeDir: string | null): void {
  if (homeDir && homeDir.trim()) {
    const resolvedHomeDir = resolve(homeDir);
    process.env[INTERPRETER_USER_DATA_DIR_ENV] = resolvedHomeDir;
    process.env[INTERPRETER_HOME_ENV] = resolvedHomeDir;
    process.env[CODEX_HOME_ENV] = pathJoin(resolvedHomeDir, 'codex-home');
  } else {
    delete process.env[INTERPRETER_USER_DATA_DIR_ENV];
    delete process.env[INTERPRETER_HOME_ENV];
    delete process.env[CODEX_HOME_ENV];
  }
  resetConfigStore();
}

/**
 * Invalidate the migration flag and force re-check from disk.
 * Used by tests when the config file is modified externally.
 */
export async function reloadConfig(): Promise<AppConfig> {
  migrationDone = false;
  migrationPromise = null;
  modelConfigMigrationDone = false;
  clearInMemoryModelConfigState();
  return loadConfig();
}

export async function getAgentConfig(agentId: string): Promise<AgentConfig> {
  const config = await loadConfig();
  return config.agents[agentId] || {};
}

export async function setAgentConfig(agentId: string, agentConfig: AgentConfig): Promise<void> {
  const config = await loadConfig();
  config.agents[agentId] = agentConfig;
  await saveConfig(config);
}

export async function getDefaultAgent(): Promise<string | undefined> {
  const config = await loadConfig();
  return config.defaultAgent;
}

export async function setDefaultAgent(agentId: string): Promise<void> {
  const config = await loadConfig();
  config.defaultAgent = agentId;
  await saveConfig(config);
}

export async function markAuthenticated(agentId: string, methodId: string, email?: string): Promise<void> {
  const config = await loadConfig();
  const agentConfig = config.agents[agentId] || {};
  agentConfig.authenticated = true;
  agentConfig.selectedAuthMethod = methodId;
  agentConfig.lastAuthenticatedAt = Date.now();
  if (email) {
    agentConfig.oauthEmail = email;
  }
  config.agents[agentId] = agentConfig;
  await saveConfig(config);
}

export async function clearAuth(agentId: string): Promise<void> {
  const config = await loadConfig();
  const agentConfig = config.agents[agentId] || {};
  agentConfig.authenticated = false;
  agentConfig.selectedAuthMethod = undefined;
  agentConfig.apiKeys = undefined;
  agentConfig.oauthEmail = undefined;
  agentConfig.lastAuthenticatedAt = undefined;
  config.agents[agentId] = agentConfig;
  await saveConfig(config);
}

// Testing utilities
export function getWatchedConfigFilePathForTests(): string | null {
  return watchedConfigFilePath;
}

export function setConfigOverride(config: AppConfig | null): void {
  overrideConfig = config;
  migrationDone = false;
  migrationPromise = null;
  modelConfigMigrationDone = false;
}

export function clearConfigCache(): void {
  overrideConfig = null;
  resetConfigStore();
}

// NOTE(interpreter-cli-mcp): Interpreter persists app-managed MCP server configs under
// config.mcpServers. The generated CLI never reads these directly; ToolManager
// uses them for app/display state and `CodexAppServerClient.syncMcpServersFromConfigStore()`
// syncs enabled entries into the app-server MCP runtime.
// MCP Server Configuration Functions
export async function addMcpServer(server: McpServerConfig): Promise<void> {
  const config = await loadConfig();
  if (!config.mcpServers) config.mcpServers = {};

  config.mcpServers[server.id] = server;
  await saveConfig(config);
}

export async function removeMcpServer(serverId: string): Promise<void> {
  const config = await loadConfig();
  if (config.mcpServers) {
    delete config.mcpServers[serverId];
    await saveConfig(config);
  }
}

export async function updateMcpServer(serverId: string, updates: Partial<McpServerConfig>): Promise<void> {
  const config = await loadConfig();
  if (!config.mcpServers?.[serverId]) {
    throw new Error(`MCP server ${serverId} not found`);
  }
  config.mcpServers[serverId] = { ...config.mcpServers[serverId], ...updates };
  await saveConfig(config);
}

export async function getMcpServer(serverId: string): Promise<McpServerConfig | undefined> {
  const config = await loadConfig();
  return config.mcpServers?.[serverId];
}

export async function listMcpServers(): Promise<McpServerConfig[]> {
  const config = await loadConfig();
  return Object.values(config.mcpServers || {});
}

export async function setMcpServerConnectionFailure(
  serverId: string,
  failure: McpServerConnectionFailure,
): Promise<void> {
  const config = await loadConfig();
  const server = config.mcpServers?.[serverId];
  if (!server) {
    return;
  }

  server.lastConnectionFailure = failure;
  await saveConfig(config);
}

export async function clearMcpServerConnectionFailure(serverId: string): Promise<void> {
  const config = await loadConfig();
  const server = config.mcpServers?.[serverId];
  if (!server || server.lastConnectionFailure === undefined) {
    return;
  }

  delete server.lastConnectionFailure;
  await saveConfig(config);
}

// Built-in Tools Configuration Functions
export async function isBuiltinToolEnabled(serverId: string): Promise<boolean> {
  const config = await loadConfig();
  // Default to enabled if not explicitly set
  return config.builtinToolsEnabled?.[serverId] ?? true;
}

export async function setBuiltinToolEnabled(serverId: string, enabled: boolean): Promise<void> {
  const config = await loadConfig();
  if (!config.builtinToolsEnabled) config.builtinToolsEnabled = {};
  config.builtinToolsEnabled[serverId] = enabled;
  await saveConfig(config);
}

export async function listBuiltinToolsEnabled(): Promise<Record<string, boolean>> {
  const config = await loadConfig();
  return config.builtinToolsEnabled || {};
}

export async function getCodexNetworkAccess(): Promise<boolean> {
  const config = await loadConfig();
  return config.codexNetworkAccess ?? true;
}

export async function setCodexNetworkAccess(enabled: boolean): Promise<void> {
  const config = await loadConfig();
  config.codexNetworkAccess = enabled;
  await saveConfig(config);
}

export type CodexApprovalPolicy = 'never' | 'on-failure' | 'on-request' | 'untrusted';
const VALID_APPROVAL_POLICIES: CodexApprovalPolicy[] = ['never', 'on-failure', 'on-request', 'untrusted'];

export async function getCodexApprovalPolicy(): Promise<CodexApprovalPolicy> {
  const config = await loadConfig();
  const policy = config.codexApprovalPolicy ?? 'never';
  return VALID_APPROVAL_POLICIES.includes(policy) ? policy : 'never';
}

export function getCodexApprovalPolicySync(): CodexApprovalPolicy {
  if (overrideConfig) {
    const policy = overrideConfig.codexApprovalPolicy ?? 'never';
    return VALID_APPROVAL_POLICIES.includes(policy) ? policy : 'never';
  }
  const policy = readStoreValue('codexApprovalPolicy') ?? 'never';
  return VALID_APPROVAL_POLICIES.includes(policy) ? policy : 'never';
}

export async function setCodexApprovalPolicy(policy: CodexApprovalPolicy): Promise<void> {
  if (!VALID_APPROVAL_POLICIES.includes(policy)) return;
  const config = await loadConfig();
  config.codexApprovalPolicy = policy;
  await saveConfig(config);
}

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
const VALID_SANDBOX_MODES: CodexSandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];

export async function getCodexSandboxMode(): Promise<CodexSandboxMode> {
  const config = await loadConfig();
  const mode = config.codexSandboxMode ?? 'workspace-write';
  return VALID_SANDBOX_MODES.includes(mode) ? mode : 'workspace-write';
}

export function getCodexSandboxModeSync(): CodexSandboxMode {
  if (overrideConfig) {
    const mode = overrideConfig.codexSandboxMode ?? 'workspace-write';
    return VALID_SANDBOX_MODES.includes(mode) ? mode : 'workspace-write';
  }
  const mode = readStoreValue('codexSandboxMode') ?? 'workspace-write';
  return VALID_SANDBOX_MODES.includes(mode) ? mode : 'workspace-write';
}

export async function setCodexSandboxMode(mode: CodexSandboxMode): Promise<void> {
  if (!VALID_SANDBOX_MODES.includes(mode)) return;
  const config = await loadConfig();
  config.codexSandboxMode = mode;
  await saveConfig(config);
}

export type CodexReadAccessMode = 'workspace-only' | 'full-system';
const VALID_READ_ACCESS_MODES: CodexReadAccessMode[] = ['workspace-only', 'full-system'];

export async function getCodexReadAccessMode(): Promise<CodexReadAccessMode> {
  const config = await loadConfig();
  const mode = config.codexReadAccessMode ?? 'full-system';
  return VALID_READ_ACCESS_MODES.includes(mode) ? mode : 'full-system';
}

export function getCodexReadAccessModeSync(): CodexReadAccessMode {
  if (overrideConfig) {
    const mode = overrideConfig.codexReadAccessMode ?? 'full-system';
    return VALID_READ_ACCESS_MODES.includes(mode) ? mode : 'full-system';
  }
  const mode = readStoreValue('codexReadAccessMode') ?? 'full-system';
  return VALID_READ_ACCESS_MODES.includes(mode) ? mode : 'full-system';
}

export async function setCodexReadAccessMode(mode: CodexReadAccessMode): Promise<void> {
  if (!VALID_READ_ACCESS_MODES.includes(mode)) return;
  const config = await loadConfig();
  config.codexReadAccessMode = mode;
  await saveConfig(config);
}

export async function getCodexMacosTempAccess(): Promise<boolean> {
  const config = await loadConfig();
  return config.codexMacosTempAccess ?? true;
}

export function getCodexMacosTempAccessSync(): boolean {
  if (overrideConfig) return overrideConfig.codexMacosTempAccess ?? true;
  return readStoreValue('codexMacosTempAccess') ?? true;
}

export async function setCodexMacosTempAccess(enabled: boolean): Promise<void> {
  const config = await loadConfig();
  config.codexMacosTempAccess = enabled;
  await saveConfig(config);
}

export async function getCodexMacosScreenshotAccess(): Promise<boolean> {
  const config = await loadConfig();
  return config.codexMacosScreenshotAccess ?? true;
}

export function getCodexMacosScreenshotAccessSync(): boolean {
  if (overrideConfig) return overrideConfig.codexMacosScreenshotAccess ?? true;
  return readStoreValue('codexMacosScreenshotAccess') ?? true;
}

export async function setCodexMacosScreenshotAccess(enabled: boolean): Promise<void> {
  const config = await loadConfig();
  config.codexMacosScreenshotAccess = enabled;
  await saveConfig(config);
}

export async function getSandboxNetworkAccess(): Promise<boolean> {
  const config = await loadConfig();
  return config.sandboxNetworkAccess ?? false;
}

export async function setSandboxNetworkAccess(enabled: boolean): Promise<void> {
  const config = await loadConfig();
  config.sandboxNetworkAccess = enabled;
  await saveConfig(config);
}

/**
 * Get the browser shared-page access policy.
 */
export async function getBrowserAccessPolicy(): Promise<BrowserAccessPolicy> {
  const config = await loadConfig();
  return normalizeBrowserAccessPolicy(config.browserAccessPolicy ?? DEFAULT_BROWSER_ACCESS_POLICY);
}

/**
 * Synchronous version for relay enforcement hot paths.
 */
export function getBrowserAccessPolicySync(): BrowserAccessPolicy {
  if (overrideConfig) {
    return normalizeBrowserAccessPolicy(
      overrideConfig.browserAccessPolicy ?? DEFAULT_BROWSER_ACCESS_POLICY,
    );
  }

  return normalizeBrowserAccessPolicy(
    readStoreValue('browserAccessPolicy') ?? DEFAULT_BROWSER_ACCESS_POLICY,
  );
}

/**
 * Set the browser shared-page access policy.
 */
export async function setBrowserAccessPolicy(policy: BrowserAccessPolicy): Promise<BrowserAccessPolicy> {
  const config = await loadConfig();
  const normalizedPolicy = normalizeBrowserAccessPolicy(policy);
  config.browserAccessPolicy = normalizedPolicy;
  await saveConfig(config);
  return normalizedPolicy;
}

export async function getCuaAccessPolicy(): Promise<CuaAccessPolicy> {
  const config = await loadConfig();
  return normalizeCuaAccessPolicy(config.cuaAccessPolicy ?? DEFAULT_CUA_ACCESS_POLICY);
}

export function getCuaAccessPolicySync(): CuaAccessPolicy {
  if (overrideConfig) {
    return normalizeCuaAccessPolicy(
      overrideConfig.cuaAccessPolicy ?? DEFAULT_CUA_ACCESS_POLICY,
    );
  }

  return normalizeCuaAccessPolicy(
    readStoreValue('cuaAccessPolicy') ?? DEFAULT_CUA_ACCESS_POLICY,
  );
}

export async function setCuaAccessPolicy(policy: CuaAccessPolicy): Promise<CuaAccessPolicy> {
  const config = await loadConfig();
  const normalizedPolicy = normalizeCuaAccessPolicy(policy);
  config.cuaAccessPolicy = normalizedPolicy;
  await saveConfig(config);
  return normalizedPolicy;
}

// Reset config to default
export async function resetConfig(): Promise<void> {
  getStore().store = { agents: {} };
  await saveModelConfigState(createDefaultModelConfigState());
  modelConfigMigrationDone = true;
}

// ============================================================
// Full Config - THE canonical view for agent tools and UI
// ============================================================

/**
 * Get the complete config for external use (agent tools, UI).
 * Builtin providers are ensured on load.
 * Removes sensitive fields (authToken, refreshToken).
 */
export async function getFullConfig(): Promise<Record<string, unknown>> {
  const config = await loadConfigWithModelState();

  // Clone and remove sensitive fields
  const fullConfig: Record<string, unknown> = { ...config };
  delete fullConfig.authToken;
  delete fullConfig.refreshToken;

  return fullConfig;
}

// Profile Configuration Functions

/**
 * Get all stored profiles.
 */
export async function getAllProfiles(): Promise<Profile[]> {
  const config = await loadConfigWithModelState();
  return config.profiles || [];
}

// Provider Configuration Functions

/**
 * Get all providers as array (builtin providers are guaranteed by loadConfig)
 */
export async function getAllProviders(): Promise<Provider[]> {
  const config = await loadConfigWithModelState();
  return Object.values(config.providers || {});
}

/**
 * Get only custom profiles (excluding built-in)
 */
export async function getCustomProfiles(): Promise<Profile[]> {
  const config = await loadConfigWithModelState();
  const storedProfiles = config.profiles || [];
  return storedProfiles.filter(p => !isBuiltinProfile(p.id));
}

/**
 * Get a profile by ID (checks stored customizations first, then defaults)
 */
export async function getProfile(profileId: string): Promise<Profile | undefined> {
  const config = await loadConfigWithModelState();
  const storedProfiles = config.profiles || [];

  // Only stored profiles exist; nothing is implicitly merged in.
  const stored = storedProfiles.find(p => p.id === profileId);
  if (stored) return stored;

  return undefined;
}

/**
 * Validate that provider IDs in a profile reference existing providers
 * Checks both profile.providerId and profile.visionModel.providerId
 */
function validateProfileProviderRefs(profile: Partial<Profile>, config: AppConfig): void {
  const storedProviders = config.providers || {};

  // Helper to check if a provider exists
  const providerExists = (providerId: string): boolean => {
    // Check stored providers (includes customized builtins)
    if (storedProviders[providerId]) return true;
    // Check default builtin providers
    if (getBuiltinProvider(providerId)) return true;
    return false;
  };

  // Validate main providerId
  if (profile.providerId && !providerExists(profile.providerId)) {
    throw new Error(`Provider "${profile.providerId}" not found. Create it in Settings > Providers first.`);
  }

  // Validate visionModel.providerId
  if (profile.visionModel?.providerId && !providerExists(profile.visionModel.providerId)) {
    throw new Error(`Vision model provider "${profile.visionModel.providerId}" not found. Create it in Settings > Providers first.`);
  }

  // Validate fastModel.providerId
  if (profile.fastModel?.providerId && !providerExists(profile.fastModel.providerId)) {
    throw new Error(`Fast model provider "${profile.fastModel.providerId}" not found. Create it in Settings > Providers first.`);
  }
}

/**
 * Add a new custom profile
 */
export async function addProfile(profile: Profile): Promise<void> {
  if (isBuiltinProfile(profile.id)) {
    throw new Error('Cannot add a profile with a built-in ID');
  }

  const config = await loadConfigWithModelState();

  // Validate provider references exist
  validateProfileProviderRefs(profile, config);
  if (!config.profiles) {
    config.profiles = getDefaultProfilesConfig().profiles;
  }

  // Check for duplicate ID
  if (config.profiles.some(p => p.id === profile.id)) {
    throw new Error(`Profile with ID ${profile.id} already exists`);
  }

  config.profiles.push({ ...profile, isBuiltin: false });
  await saveConfig(config);
}

/**
 * Update an existing profile (both builtin and custom)
 * Builtin profiles can have their settings customized (permissions, disabled tools, etc.)
 * They are stored in config.profiles with their customizations
 */
export async function updateProfile(profileId: string, updates: Partial<Profile>): Promise<void> {
  const config = await loadConfigWithModelState();
  if (!config.profiles) {
    config.profiles = [];
  }

  // Validate provider references exist
  validateProfileProviderRefs(updates, config);

  const isBuiltin = isBuiltinProfile(profileId);
  const index = config.profiles.findIndex(p => p.id === profileId);

  if (isBuiltin) {
    // For builtin profiles, get the base defaults and merge with updates
    const defaults = getBuiltinProfileDefaults(profileId);
    if (!defaults) {
      throw new Error(`Builtin profile ${profileId} not found`);
    }

    const updatedProfile = {
      ...defaults,
      ...updates,
      id: profileId, // Prevent ID from being changed
      isBuiltin: true, // Keep builtin flag
    };

    if (index !== -1) {
      // Update existing customized builtin profile
      config.profiles[index] = updatedProfile;
    } else {
      // Add customized builtin profile to storage
      config.profiles.push(updatedProfile);
    }
  } else {
    // Custom profile - must exist
    if (index === -1) {
      throw new Error(`Profile ${profileId} not found`);
    }

    config.profiles[index] = {
      ...config.profiles[index],
      ...updates,
      id: profileId, // Prevent ID from being changed
      isBuiltin: false, // Ensure it stays non-builtin
    };
  }

  await saveConfig(config);
}

/**
 * Delete a custom profile
 */
export async function deleteProfile(profileId: string): Promise<void> {
  if (isBuiltinProfile(profileId)) {
    throw new Error('Cannot delete built-in profiles');
  }

  const config = await loadConfigWithModelState();
  if (!config.profiles) return;

  config.profiles = config.profiles.filter(p => p.id !== profileId);

  // Clear selected/fast pointers if they point to the deleted profile
  if (config.defaultProfileId === profileId) {
    delete config.defaultProfileId;
  }
  if (config.fastProfileId === profileId) {
    delete config.fastProfileId;
  }

  await saveConfig(config);
}

/**
 * Get the selected profile ID for new agents.
 * Returns null if no profile has been selected yet.
 */
export async function getDefaultProfileId(): Promise<string | null> {
  const config = await loadConfigWithModelState();
  return config.defaultProfileId ?? null;
}

/**
 * Set the selected profile ID for new agents.
 */
export async function setDefaultProfileId(profileId: string): Promise<void> {
  // Verify the profile exists
  const profile = await getProfile(profileId);
  if (!profile) {
    throw new Error(`Profile ${profileId} not found`);
  }

  const config = await loadConfigWithModelState();
  config.defaultProfileId = profileId;
  await saveConfig(config);
}

/**
 * Get the selected profile for new agents (full profile object).
 * Returns null if no profile has been selected.
 */
export async function getDefaultProfile(): Promise<Profile | null> {
  const profileId = await getDefaultProfileId();
  if (!profileId) return null;
  const profile = await getProfile(profileId);
  return profile || null;
}

/**
 * Get the global fast profile ID used by subagent tooling.
 */
export async function getFastProfileId(): Promise<string | null> {
  const config = await loadConfigWithModelState();
  return config.fastProfileId ?? null;
}

/**
 * Set the global fast profile ID used by subagent tooling.
 */
export async function setFastProfileId(profileId: string): Promise<void> {
  const profile = await getProfile(profileId);
  if (!profile) {
    throw new Error(`Profile ${profileId} not found`);
  }

  const config = await loadConfigWithModelState();
  config.fastProfileId = profileId;
  await saveConfig(config);
}

/**
 * Get the global fast profile (full profile object).
 */
export async function getFastProfile(): Promise<Profile | null> {
  const profileId = await getFastProfileId();
  if (!profileId) return null;
  const profile = await getProfile(profileId);
  return profile || null;
}

/**
 * Reset a built-in profile to its original defaults
 */
export async function resetProfile(profileId: string): Promise<Profile> {
  const defaults = getBuiltinProfileDefaults(profileId);
  if (!defaults) {
    throw new Error(`Profile ${profileId} is not a built-in profile and cannot be reset`);
  }

  const config = await loadConfigWithModelState();
  if (!config.profiles) {
    config.profiles = getDefaultProfilesConfig().profiles;
  }

  // Find and update or add the profile
  const index = config.profiles.findIndex(p => p.id === profileId);
  if (index !== -1) {
    config.profiles[index] = { ...defaults };
  } else {
    config.profiles.push({ ...defaults });
  }

  await saveConfig(config);
  return defaults;
}

// Background Opacity Configuration Functions

/**
 * Get the background opacity setting (0-1 range)
 * Defaults to a translucent but readable surface if not set.
 */
export async function getBackgroundOpacity(): Promise<number> {
  const config = await loadConfig();
  return config.backgroundOpacity ?? DEFAULT_BACKGROUND_OPACITY;
}

/**
 * Set the background opacity setting (0-1 range)
 */
export async function setBackgroundOpacity(opacity: number): Promise<void> {
  if (opacity < 0 || opacity > 1) {
    throw new Error('Background opacity must be between 0 and 1');
  }

  await updateSettingsSnapshot((snapshot) => ({
    ...snapshot,
    backgroundOpacity: opacity,
  }));
}

// Zoom Configuration Functions

/**
 * Get the interface zoom factor
 * Defaults to 1 if not set
 */
export async function getZoomFactor(): Promise<number> {
  const config = await loadConfigForRead('zoom factor');
  return config.zoomFactor ?? 1;
}

/**
 * Set the interface zoom factor
 */
export async function setZoomFactor(zoomFactor: number): Promise<void> {
  if (!Number.isFinite(zoomFactor) || zoomFactor < 0.5 || zoomFactor > 3) {
    throw new Error('Zoom factor must be between 0.5 and 3');
  }

  await updateSettingsSnapshot((snapshot) => ({
    ...snapshot,
    zoomFactor,
  }));
}

// Theme Configuration Functions

/**
 * Get the theme setting
 * Defaults to 'system' if not set
 */
export async function getTheme(): Promise<'light' | 'dark' | 'system'> {
  const config = await loadConfigForRead('theme');
  return config.theme ?? 'system';
}

/**
 * Set the theme setting
 */
export async function setTheme(theme: 'light' | 'dark' | 'system'): Promise<void> {
  await updateSettingsSnapshot((snapshot) => ({
    ...snapshot,
    theme,
  }));
}

// Language Configuration Functions

/**
 * Get the language setting
 * Returns null if not set (auto-detect from OS)
 */
export async function getLanguage(): Promise<string | null> {
  const config = await loadConfigForRead('language');
  return config.language ?? null;
}

/**
 * Set the language setting
 */
export async function setLanguage(language: string): Promise<void> {
  await updateSettingsSnapshot((snapshot) => ({
    ...snapshot,
    language: language as SettingsSnapshot['language'],
  }));

  const resolvedStripChineseCharacters = resolveStripChineseCharactersForLanguage(
    DEFAULT_STT_SETTINGS.stripChineseCharacters,
    language,
  );

  const config = await loadConfig();
  const currentSttSettings = config.stt ?? { ...DEFAULT_STT_SETTINGS, backend: getDefaultSttBackendForPlatform() };
  if (currentSttSettings.stripChineseCharacters === resolvedStripChineseCharacters) {
    return;
  }

  config.stt = {
    ...currentSttSettings,
    stripChineseCharacters: resolvedStripChineseCharacters,
  };
  await saveConfig(config);
}

// Primary Color Configuration Functions

/**
 * Get the primary color setting
 * Defaults to 'gray' if not set
 */
export async function getPrimaryColor(): Promise<string> {
  const config = await loadConfig();
  return config.primaryColor ?? 'gray';
}

/**
 * Set the primary color setting
 */
export async function setPrimaryColor(color: string): Promise<void> {
  if (!isValidPrimaryColor(color)) {
    throw new Error(`Invalid primary color: ${color}. Valid options: ${PRIMARY_COLOR_IDS.join(', ')}`);
  }
  await updateSettingsSnapshot((snapshot) => ({
    ...snapshot,
    primaryColor: color,
  }));
}

// Text-to-Speech Settings Functions

/**
 * Get the text-to-speech settings
 */
export async function getTtsSettings(): Promise<TtsSettings> {
  const config = await loadConfig();
  if (!hasValidTtsSettings(config.tts)) {
    config.tts = { ...DEFAULT_TTS_SETTINGS };
    await saveConfig(config);
  }
  return config.tts;
}

/**
 * Set text-to-speech settings
 */
export async function setTtsSettings(settings: TtsSettings): Promise<void> {
  if (!getTtsModelById(settings.modelId)) {
    throw new Error(`Invalid TTS model ID: ${settings.modelId}`);
  }
  if (!(TTS_PROVIDERS as readonly string[]).includes(settings.provider)) {
    throw new Error(`Invalid TTS provider: ${settings.provider}`);
  }
  if (!Number.isInteger(settings.voiceId) || settings.voiceId < 0) {
    throw new Error('voiceId must be a non-negative integer');
  }
  if (!Number.isFinite(settings.speed) || settings.speed <= 0) {
    throw new Error('speed must be a positive number');
  }
  if (!Number.isFinite(settings.pitch) || settings.pitch < -5 || settings.pitch > 5) {
    throw new Error('pitch must be between -5 and 5 semitones');
  }
  if (typeof settings.readAssistantMessages !== 'boolean') {
    throw new Error('readAssistantMessages must be a boolean');
  }
  if (typeof settings.autotuneEnabled !== 'boolean') {
    throw new Error('autotuneEnabled must be a boolean');
  }

  const config = await loadConfig();
  config.tts = settings;
  await saveConfig(config);
}

// Speech-to-Text Settings Functions

/**
 * Get the speech-to-text settings
 */
export async function getSttSettings(): Promise<SttSettings> {
  const config = await loadConfig();
  if (!config.stt) {
    config.stt = { ...DEFAULT_STT_SETTINGS, backend: getDefaultSttBackendForPlatform() };
    await saveConfig(config);
  }
  // Backfill new fields for existing configs
  let needsSave = false;
  if (typeof config.stt.sendCommand !== 'string') {
    config.stt.sendCommand = DEFAULT_STT_SETTINGS.sendCommand;
    needsSave = true;
  }
  if (typeof config.stt.stripChineseCharacters !== 'boolean') {
    config.stt.stripChineseCharacters = DEFAULT_STT_SETTINGS.stripChineseCharacters;
    needsSave = true;
  }
  if (typeof config.stt.newChatCommand !== 'string') {
    config.stt.newChatCommand = DEFAULT_STT_SETTINGS.newChatCommand;
    needsSave = true;
  }
  if (!config.stt.voiceMode) {
    config.stt.voiceMode = DEFAULT_STT_SETTINGS.voiceMode;
    needsSave = true;
  }
  if (!Array.isArray(config.stt.ambientTriggerPhrases) || config.stt.ambientTriggerPhrases.some((phrase) => typeof phrase !== 'string')) {
    config.stt.ambientTriggerPhrases = [...DEFAULT_STT_SETTINGS.ambientTriggerPhrases];
    needsSave = true;
  }
  config.stt.ambientTriggerPhrases = normalizeAmbientPhrases(
    config.stt.ambientTriggerPhrases,
    DEFAULT_STT_SETTINGS.ambientTriggerPhrases,
  );
  if (!Array.isArray(config.stt.ambientEndPhrases) || config.stt.ambientEndPhrases.some((phrase) => typeof phrase !== 'string')) {
    config.stt.ambientEndPhrases = [...DEFAULT_STT_SETTINGS.ambientEndPhrases];
    needsSave = true;
  }
  config.stt.ambientEndPhrases = normalizeAmbientPhrases(
    config.stt.ambientEndPhrases,
    DEFAULT_STT_SETTINGS.ambientEndPhrases,
  );
  if ('ambientTriggerWord' in config.stt) {
    delete (config.stt as Record<string, unknown>).ambientTriggerWord;
    needsSave = true;
  }
  if ('ambientEndPhrase' in config.stt) {
    delete (config.stt as Record<string, unknown>).ambientEndPhrase;
    needsSave = true;
  }
  if ('interimIntervalMs' in config.stt) {
    delete (config.stt as Record<string, unknown>).interimIntervalMs;
    needsSave = true;
  }
  const resolvedStripChineseCharacters = resolveStripChineseCharactersForLanguage(
    config.stt.stripChineseCharacters,
    config.language ?? null,
  );
  if (config.stt.stripChineseCharacters !== resolvedStripChineseCharacters) {
    config.stt.stripChineseCharacters = resolvedStripChineseCharacters;
    needsSave = true;
  }
  if (needsSave) {
    await saveConfig(config);
  }
  return config.stt;
}

/**
 * Set speech-to-text settings
 */
export async function setSttSettings(settings: SttSettings): Promise<void> {
  if (!(STT_BACKENDS as readonly string[]).includes(settings.backend)) {
    throw new Error(`Invalid STT backend: ${settings.backend}`);
  }

  if (process.platform === 'win32' && settings.backend !== 'moonshine') {
    throw new Error('Windows only supports the moonshine STT backend');
  }

  if (!Number.isFinite(settings.silenceTimeoutMs)
      || settings.silenceTimeoutMs < STT_MIN_SILENCE_TIMEOUT_MS
      || settings.silenceTimeoutMs > STT_MAX_SILENCE_TIMEOUT_MS) {
    throw new Error(`silenceTimeoutMs must be between ${STT_MIN_SILENCE_TIMEOUT_MS} and ${STT_MAX_SILENCE_TIMEOUT_MS}`);
  }

  if (!Number.isFinite(settings.fastSentenceSilenceTimeoutMs)
      || settings.fastSentenceSilenceTimeoutMs < STT_MIN_FAST_SENTENCE_TIMEOUT_MS
      || settings.fastSentenceSilenceTimeoutMs > STT_MAX_FAST_SENTENCE_TIMEOUT_MS) {
    throw new Error(`fastSentenceSilenceTimeoutMs must be between ${STT_MIN_FAST_SENTENCE_TIMEOUT_MS} and ${STT_MAX_FAST_SENTENCE_TIMEOUT_MS}`);
  }

  if (!Number.isFinite(settings.previewBeforeSendMs)
      || settings.previewBeforeSendMs < STT_MIN_PREVIEW_BEFORE_SEND_MS
      || settings.previewBeforeSendMs > STT_MAX_PREVIEW_BEFORE_SEND_MS) {
    throw new Error(`previewBeforeSendMs must be between ${STT_MIN_PREVIEW_BEFORE_SEND_MS} and ${STT_MAX_PREVIEW_BEFORE_SEND_MS}`);
  }

  if (!Array.isArray(settings.ambientTriggerPhrases) || settings.ambientTriggerPhrases.length === 0) {
    throw new Error('ambientTriggerPhrases must contain at least one phrase');
  }

  if (!Array.isArray(settings.ambientEndPhrases) || settings.ambientEndPhrases.length === 0) {
    throw new Error('ambientEndPhrases must contain at least one phrase');
  }

  if (typeof settings.stripChineseCharacters !== 'boolean') {
    throw new Error('stripChineseCharacters must be a boolean');
  }

  const config = await loadConfig();
  config.stt = {
    ...settings,
    stripChineseCharacters: resolveStripChineseCharactersForLanguage(
      settings.stripChineseCharacters,
      config.language ?? null,
    ),
  };
  await saveConfig(config);
}

// Last Workspace Functions

/**
 * Get the last opened workspace path
 */
export async function getLastWorkspace(): Promise<string | null> {
  const config = await loadConfig();
  return config.lastWorkspace ?? null;
}

/**
 * Set the last opened workspace path
 */
export async function setLastWorkspace(workspacePath: string | null): Promise<void> {
  const config = await loadConfig();
  config.lastWorkspace = workspacePath;
  await saveConfig(config);
}

// Recent Folders Configuration Functions

const MAX_RECENT_FOLDERS = 10;

/**
 * Get recent folders list
 */
export async function getRecentFolders(): Promise<RecentFolder[]> {
  const config = await loadConfigForRead('recent folders');
  return config.recentFolders || [];
}

/**
 * Add a folder to recent list
 */
export async function addRecentFolder(folderPath: string): Promise<void> {
  const config = await loadConfig();
  if (!config.recentFolders) {
    config.recentFolders = [];
  }

  const name = basename(folderPath) || folderPath;

  // Remove if already exists
  config.recentFolders = config.recentFolders.filter(f => f.path !== folderPath);

  // Add to front with current timestamp
  config.recentFolders.unshift({
    path: folderPath,
    name,
    lastOpened: Date.now(),
  });

  // Keep only the most recent MAX_RECENT_FOLDERS
  if (config.recentFolders.length > MAX_RECENT_FOLDERS) {
    config.recentFolders = config.recentFolders.slice(0, MAX_RECENT_FOLDERS);
  }

  await saveConfig(config);
}

/**
 * Clear recent folders list
 */
export async function clearRecentFolders(): Promise<void> {
  const config = await loadConfig();
  config.recentFolders = [];
  await saveConfig(config);
}

// =============================================================================
// Auth Token Functions (for CI/test bootstrapping)
// =============================================================================
//
// These functions provide a way to store/retrieve auth tokens from the config
// file. This is NOT the primary auth mechanism - Supabase localStorage is.
//
// Use cases:
// 1. CI: Pre-populate config file with tokens before running tests
// 2. Test isolation: Share auth between main app and test Electron instances
// 3. Bootstrap: If no Supabase session in localStorage, try config file
//
// The frontend writes tokens here on auth change (write-through) so that
// other processes (tests, CI) can access them.

/**
 * Get auth tokens from config file (for bootstrapping)
 */
export async function getAuthTokens(): Promise<{ access_token: string | null; refresh_token: string | null }> {
  const config = await loadConfig();
  return {
    access_token: config.authToken ?? null,
    refresh_token: config.refreshToken ?? null,
  };
}

export function getAuthTokensSync(): { access_token: string | null; refresh_token: string | null } {
  if (overrideConfig) {
    return {
      access_token: overrideConfig.authToken ?? null,
      refresh_token: overrideConfig.refreshToken ?? null,
    };
  }

  const config = readStoreConfigSync();
  return {
    access_token: config.authToken ?? null,
    refresh_token: config.refreshToken ?? null,
  };
}

/**
 * Save auth tokens to config file (write-through for sharing)
 */
export async function setAuthTokens(access_token: string | null, refresh_token: string | null): Promise<void> {
  const config = await loadConfig();
  config.authToken = access_token ?? undefined;
  config.refreshToken = refresh_token ?? undefined;
  await saveConfig(config);
}

/**
 * Clear auth tokens from config file
 */
export async function clearAuthTokens(): Promise<void> {
  const config = await loadConfig();
  config.authToken = undefined;
  config.refreshToken = undefined;
  await saveConfig(config);
}

// =============================================================================
// Agent Settings Functions
// =============================================================================

/**
 * Get the maximum steps setting for agent tasks
 * Defaults to 1000 if not set
 */
export async function getMaxSteps(): Promise<number> {
  const config = await loadConfig();
  return config.maxSteps ?? DEFAULT_MAX_STEPS;
}

/**
 * Synchronous version for use in hot paths - uses cached config
 * Falls back to default if cache is empty
 */
export function getMaxStepsSync(): number {
  if (overrideConfig) return overrideConfig.maxSteps ?? DEFAULT_MAX_STEPS;
  return readStoreValue('maxSteps') ?? DEFAULT_MAX_STEPS;
}

/**
 * Set the maximum steps setting for agent tasks
 */
export async function setMaxSteps(maxSteps: number): Promise<void> {
  if (maxSteps < 1) {
    throw new Error('maxSteps must be at least 1');
  }
  if (maxSteps > 10000) {
    throw new Error('maxSteps cannot exceed 10000');
  }

  await updateSettingsSnapshot((snapshot) => ({
    ...snapshot,
    maxSteps,
  }));
}

/**
 * Get the maximum subagent nesting depth
 * Defaults to 5 if not set
 */
export async function getMaxSubagentDepth(): Promise<number> {
  const config = await loadConfig();
  return config.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
}

/**
 * Synchronous version for use in hot paths - uses cached config
 * Falls back to default if cache is empty
 */
export function getMaxSubagentDepthSync(): number {
  if (overrideConfig) return overrideConfig.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH;
  return readStoreValue('maxSubagentDepth') ?? DEFAULT_MAX_SUBAGENT_DEPTH;
}

/**
 * Set the maximum subagent nesting depth
 */
export async function setMaxSubagentDepth(depth: number): Promise<void> {
  if (depth < 1) {
    throw new Error('maxSubagentDepth must be at least 1');
  }
  if (depth > 20) {
    throw new Error('maxSubagentDepth cannot exceed 20');
  }

  await updateSettingsSnapshot((snapshot) => ({
    ...snapshot,
    maxSubagentDepth: depth,
  }));
}

/**
 * Get the maximum number of task-list auto-continuations per conversation
 * Defaults to 10 if not set
 */
export async function getAutoContinuationLimit(): Promise<number> {
  const config = await loadConfig();
  return config.autoContinuationLimit ?? DEFAULT_AUTO_CONTINUATION_LIMIT;
}

/**
 * Synchronous version for use in hot paths - uses cached config
 * Falls back to default if cache is empty
 */
export function getAutoContinuationLimitSync(): number {
  if (overrideConfig) return overrideConfig.autoContinuationLimit ?? DEFAULT_AUTO_CONTINUATION_LIMIT;
  return readStoreValue('autoContinuationLimit') ?? DEFAULT_AUTO_CONTINUATION_LIMIT;
}

/**
 * Set the maximum number of task-list auto-continuations per conversation
 * 0 disables auto-continuation entirely.
 */
export async function setAutoContinuationLimit(limit: number): Promise<void> {
  if (!Number.isInteger(limit)) {
    throw new Error('autoContinuationLimit must be an integer');
  }
  if (limit < 0) {
    throw new Error('autoContinuationLimit cannot be negative');
  }
  if (limit > 100) {
    throw new Error('autoContinuationLimit cannot exceed 100');
  }

  await updateSettingsSnapshot((snapshot) => ({
    ...snapshot,
    autoContinuationLimit: limit,
  }));
}

/**
 * Get persistent custom instructions configured in Settings -> General.
 */
export async function getCustomInstructions(): Promise<string | null> {
  const config = await loadConfig();
  return normalizeCustomInstructions(config.customInstructions);
}

export async function getOnboardingCustomInstructionsDraft(): Promise<string> {
  const state = await getOnboardingState();
  return state.interviewResult?.customInstructionsDraft.trim() ?? '';
}

/**
 * Set persistent custom instructions configured in Settings -> General.
 * Empty/whitespace instructions clear the saved value.
 */
export async function setCustomInstructions(customInstructions: string): Promise<string | null> {
  if (typeof customInstructions !== 'string') {
    throw new Error('customInstructions must be a string');
  }

  const normalized = normalizeCustomInstructions(customInstructions);
  const config = await loadConfig();
  if (normalized) {
    config.customInstructions = normalized;
  } else {
    delete config.customInstructions;
  }
  await saveConfig(config);

  return normalized;
}

// =============================================================================
// Boolean UI Settings (generic)
// =============================================================================

import { BOOLEAN_UI_SETTINGS, type BooleanUISettingId } from '../shared/booleanSettings';

export async function getBooleanUISetting(id: BooleanUISettingId): Promise<boolean> {
  const config = await loadConfigForRead(`boolean setting '${id}'`);
  return (config[id] as boolean | undefined) ?? BOOLEAN_UI_SETTINGS[id].default;
}

export async function setBooleanUISetting(id: BooleanUISettingId, value: boolean): Promise<void> {
  await updateSettingsSnapshot((snapshot) => ({
    ...snapshot,
    [id]: value,
  }));
}

export function getBooleanUISettingSync(id: BooleanUISettingId): boolean {
  if (overrideConfig) return (overrideConfig[id] as boolean | undefined) ?? BOOLEAN_UI_SETTINGS[id].default;
  return (readStoreValue(id) as boolean | undefined) ?? BOOLEAN_UI_SETTINGS[id].default;
}

/**
 * Get the Interpreter Overlay settings.
 */
export async function getInterpreterOverlaySettings(): Promise<InterpreterOverlaySettings> {
  const config = await loadConfig();
  return sanitizeInterpreterOverlaySettings(config.interpreterOverlay);
}

/**
 * Set the Interpreter Overlay settings.
 */
export async function setInterpreterOverlaySettings(
  settings: InterpreterOverlaySettings,
): Promise<InterpreterOverlaySettings> {
  const config = await loadConfig();
  const nextSettings = sanitizeInterpreterOverlaySettings(settings);
  config.interpreterOverlay = nextSettings;
  await saveConfig(config);
  return nextSettings;
}

/**
 * Synchronous version for use in startup paths.
 */
export function getInterpreterOverlaySettingsSync(): InterpreterOverlaySettings {
  if (overrideConfig) {
    return sanitizeInterpreterOverlaySettings(overrideConfig.interpreterOverlay);
  }

  return sanitizeInterpreterOverlaySettings(
    readStoreConfigSync().interpreterOverlay ?? DEFAULT_INTERPRETER_OVERLAY_SETTINGS,
  );
}

/**
 * Get whether the "What's new" video has been dismissed
 * Defaults to false if not set
 */
export async function getWhatsNewDismissed(): Promise<boolean> {
  const config = await loadConfig();
  return config.whatsNewDismissed ?? false;
}

/**
 * Set whether the "What's new" video has been dismissed
 */
export async function setWhatsNewDismissed(dismissed: boolean): Promise<void> {
  const config = await loadConfig();
  config.whatsNewDismissed = dismissed;
  await saveConfig(config);
}

export async function getDismissedTopNoticeVersion(noticeId: string): Promise<string> {
  const config = await loadConfig();
  return config.dismissedTopNoticeVersions?.[noticeId] ?? '';
}

export async function setDismissedTopNoticeVersion(noticeId: string, version: string): Promise<void> {
  const config = await loadConfig();
  config.dismissedTopNoticeVersions = {
    ...(config.dismissedTopNoticeVersions ?? {}),
    [noticeId]: version,
  };
  await saveConfig(config);
}

/**
 * Get the last dismissed release-notes version.
 * Returns '' if never dismissed.
 */
export async function getLastDismissedReleaseNotesVersion(): Promise<string> {
  const config = await loadConfig();
  const v = config.lastDismissedReleaseNotesVersion;
  // Legacy configs stored a number — coerce to string for comparison.
  return v == null ? '' : String(v);
}

/**
 * Persist the last dismissed release-notes version (a RELEASE_NOTES_VERSION string).
 */
export async function setLastDismissedReleaseNotesVersion(version: string): Promise<void> {
  const config = await loadConfig();
  config.lastDismissedReleaseNotesVersion = version;
  await saveConfig(config);
}

/**
 * Get the last dismissed interview-invite version.
 * Returns '' if never dismissed.
 */
export async function getLastDismissedInterviewInviteVersion(): Promise<string> {
  const config = await loadConfig();
  return config.lastDismissedInterviewInviteVersion ?? '';
}

/**
 * Persist the last dismissed interview-invite version.
 */
export async function setLastDismissedInterviewInviteVersion(version: string): Promise<void> {
  const config = await loadConfig();
  config.lastDismissedInterviewInviteVersion = version;
  await saveConfig(config);
}

export async function getAppLaunchCount(): Promise<number> {
  const config = await loadConfig();
  return config.appLaunchCount ?? 0;
}

export async function incrementAppLaunchCount(): Promise<number> {
  const config = await loadConfig();
  const nextCount = (config.appLaunchCount ?? 0) + 1;
  config.appLaunchCount = nextCount;
  await saveConfig(config);
  return nextCount;
}
// =============================================================================
// User Info Functions
// =============================================================================

/**
 * Get the user's display name
 * Returns null if not set (indicates onboarding not completed)
 */
export async function getUserName(): Promise<string | null> {
  const config = await loadConfig();
  return config.userName ?? null;
}

/**
 * Set the user's display name
 */
export async function setUserName(name: string): Promise<void> {
  const config = await loadConfig();
  config.userName = name;
  await saveConfig(config);
}

/**
 * Clear the user's display name (resets to null for onboarding re-entry)
 */
export async function clearUserName(): Promise<void> {
  const config = await loadConfig();
  delete config.userName;
  await saveConfig(config);
}

/**
 * Get the telemetry enabled setting
 * Returns null if not set (indicates onboarding not completed for privacy step)
 */
export async function getTelemetryEnabled(): Promise<boolean | null> {
  const config = await loadConfig();
  return config.telemetryEnabled ?? null;
}

/**
 * Set the telemetry enabled setting
 */
export async function setTelemetryEnabled(enabled: boolean): Promise<void> {
  await updateSettingsSnapshot((snapshot) => ({
    ...snapshot,
    telemetryEnabled: enabled,
  }));

  // Clear the telemetry cache so the new setting takes effect immediately
  try {
    const { clearTelemetryCache } = await import('./telemetry');
    clearTelemetryCache();
  } catch {
    // Telemetry module may not be loaded yet during startup
  }
}

// =============================================================================
// Global Disabled Tools Functions
// =============================================================================

/**
 * Get the global disabled tools list
 * All MCPs in this list are disabled for all agents
 */
export async function getGlobalDisabledTools(): Promise<string[]> {
  const config = await loadConfig();
  return config.globalDisabledTools ?? [];
}

/**
 * Synchronous version for use in hot paths - uses cached config
 */
export function getGlobalDisabledToolsSync(): string[] {
  if (overrideConfig) return overrideConfig.globalDisabledTools ?? [];
  return readStoreValue('globalDisabledTools') ?? [];
}

/**
 * Set the global disabled tools list
 */
export async function setGlobalDisabledTools(tools: string[]): Promise<void> {
  const config = await loadConfig();
  config.globalDisabledTools = tools;
  await saveConfig(config);
}

// =============================================================================
// MCP/Tool Settings Functions
// =============================================================================

/**
 * Get whether the agent is allowed to add tools from the store
 * Defaults to true if not set
 */
export async function getAllowAgentAddTools(): Promise<boolean> {
  const config = await loadConfig();
  return config.allowAgentAddTools ?? true;
}

/**
 * Synchronous version for use in hot paths - uses cached config
 */
export function getAllowAgentAddToolsSync(): boolean {
  if (overrideConfig) return overrideConfig.allowAgentAddTools ?? true;
  return readStoreValue('allowAgentAddTools') ?? true;
}

/**
 * Set whether the agent is allowed to add tools from the store
 */
export async function setAllowAgentAddTools(allowed: boolean): Promise<void> {
  await updateSettingsSnapshot((snapshot) => ({
    ...snapshot,
    allowAgentAddTools: allowed,
  }));
}

/**
 * Get whether local/stdio MCP servers are allowed
 * Defaults to false if not set (more secure)
 */
export async function getAllowLocalMcpServers(): Promise<boolean> {
  const config = await loadConfig();
  return config.allowLocalMcpServers ?? false;
}

/**
 * Synchronous version for use in hot paths - uses cached config
 */
export function getAllowLocalMcpServersSync(): boolean {
  if (overrideConfig) return overrideConfig.allowLocalMcpServers ?? false;
  return readStoreValue('allowLocalMcpServers') ?? false;
}

/**
 * Set whether local/stdio MCP servers are allowed
 */
export async function setAllowLocalMcpServers(allowed: boolean): Promise<void> {
  await updateSettingsSnapshot((snapshot) => ({
    ...snapshot,
    allowLocalMcpServers: allowed,
  }));
}

// =============================================================================
// Skills Settings Functions
// =============================================================================

/**
 * Get custom skill folder paths
 * Returns empty array if not set
 */
export async function getSkillFolders(): Promise<string[]> {
  const config = await loadConfig();
  return config.skillFolders ?? [];
}

/**
 * Set custom skill folder paths
 */
export async function setSkillFolders(folders: string[]): Promise<void> {
  await updateSettingsSnapshot((snapshot) => ({
    ...snapshot,
    skillFolders: [...folders],
  }));
}

/**
 * Get whether the model is allowed to edit the skills folder
 * Defaults to false if not set
 */
export async function getAllowModelSkillEditing(): Promise<boolean> {
  const config = await loadConfig();
  return config.allowModelSkillEditing ?? true;
}

/**
 * Synchronous version for use in hot paths - uses cached config
 */
export function getAllowModelSkillEditingSync(): boolean {
  if (overrideConfig) return overrideConfig.allowModelSkillEditing ?? true;
  return readStoreValue('allowModelSkillEditing') ?? true;
}

/**
 * Set whether the model is allowed to edit the skills folder
 */
export async function setAllowModelSkillEditing(allowed: boolean): Promise<void> {
  await updateSettingsSnapshot((snapshot) => ({
    ...snapshot,
    allowModelSkillEditing: allowed,
  }));
}

// =============================================================================
// User Email Functions (from onboarding Stay Connected screen)
// =============================================================================

/**
 * Get the user's email address
 * Returns null if not set
 */
export async function getUserEmail(): Promise<string | null> {
  const config = await loadConfig();
  return config.userEmail ?? null;
}

/**
 * Set the user's email address
 */
export async function setUserEmail(email: string): Promise<void> {
  const config = await loadConfig();
  config.userEmail = email;
  await saveConfig(config);
}

// =============================================================================
// Onboarding State Functions
// =============================================================================

/**
 * Get the explicit durable onboarding state.
 */
export async function getOnboardingState(): Promise<OnboardingState> {
  const config = await loadConfig();
  return config.onboardingState ?? createDefaultOnboardingState();
}

/**
 * Persist the explicit durable onboarding state.
 */
export async function setOnboardingState(onboardingState: OnboardingState): Promise<void> {
  const config = await loadConfig();
  config.onboardingState = onboardingState;
  await saveConfig(config);
}

/**
 * Reset onboarding progress to the current default state.
 */
export async function resetOnboardingState(): Promise<void> {
  await setOnboardingState(createDefaultOnboardingState());
}

// =============================================================================
// Onboarding Persona Functions (derived from silent environment detection)
// =============================================================================

export interface OnboardingPersona {
  bucket: 'non-developer' | 'developer' | 'developer-local-ai';
  subCategories: string[];
  detectedProviders: string[];
}

/**
 * Get the onboarding persona derived from environment detection
 * Returns null if not set (detection hasn't run)
 */
export async function getOnboardingPersona(): Promise<OnboardingPersona | null> {
  const config = await loadConfig();
  return config.onboardingPersona ?? null;
}

/**
 * Set the onboarding persona from environment detection results
 */
export async function setOnboardingPersona(persona: OnboardingPersona): Promise<void> {
  const config = await loadConfig();
  config.onboardingPersona = persona;
  await saveConfig(config);
}

// =============================================================================
// Onboarding Permissions Functions
// =============================================================================

export interface OnboardingPermissions {
  readOutsideWorkspace: 'deny' | 'allow';
  writeFilesInWorkspace: boolean;
}

/**
 * Get the onboarding permissions settings
 * Mirrors the effective global file permission toggles.
 */
export async function getPermissions(): Promise<OnboardingPermissions> {
  const config = await loadConfig();
  const sandboxMode = config.codexSandboxMode ?? 'workspace-write';
  const readAccessMode = config.codexReadAccessMode ?? 'full-system';
  return {
    readOutsideWorkspace: readAccessMode === 'full-system' ? 'allow' : 'deny',
    writeFilesInWorkspace: sandboxMode !== 'read-only',
  };
}

/**
 * Set the onboarding permissions settings
 */
export async function setPermissions(perms: OnboardingPermissions): Promise<void> {
  const config = await loadConfig();
  config.codexReadAccessMode = perms.readOutsideWorkspace === 'allow' ? 'full-system' : 'workspace-only';
  config.codexSandboxMode = perms.writeFilesInWorkspace ? 'workspace-write' : 'read-only';
  await saveConfig(config);
}
