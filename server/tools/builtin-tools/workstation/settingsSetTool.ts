/**
 * Settings Set Tool
 *
 * Set Interpreter settings using JS-style path syntax.
 * Examples: "theme", "profiles[0].name", "mcpServers.my-server"
 *
 * Validates the ENTIRE config against the schema after any change.
 * Invalid changes are rejected - config is never corrupted.
 */

import lodash from 'lodash';
import type { BuiltinToolDefinition, BuiltinToolContext } from '../../builtinTools';
import * as configStore from '../../../configStore';
import { broadcastEvent } from '../../../handlers/broadcast';
import {
  setTheme as setThemeHandler,
  setLanguage as setLanguageHandler,
  setPrimaryColor as setPrimaryColorHandler,
  setBackgroundOpacity as setBackgroundOpacityHandler,
  setMaxSteps as setMaxStepsHandler,
  setMaxSubagentDepth as setMaxSubagentDepthHandler,
  setAutoContinuationLimit as setAutoContinuationLimitHandler,
  setBooleanUISetting as setBooleanUISettingHandler,
  setAllowAgentAddTools as setAllowAgentAddToolsHandler,
  setAllowLocalMcpServers as setAllowLocalMcpServersHandler,
  setSkillFolders as setSkillFoldersHandler,
  setAllowModelSkillEditing as setAllowModelSkillEditingHandler,
} from '../../../handlers/settings';
import * as globalToolsHandlers from '../../../handlers/globalTools';
import { validateConfig } from '../../../configSchema';
import { BUILTIN_PROFILES } from '../../../../shared/types/profile';
import { BUILTIN_PROVIDERS, isBuiltinProvider } from '../../../../shared/types/provider';
import { approvalManager } from '../../../approvalManager';
import { BOOLEAN_UI_SETTING_IDS, type BooleanUISettingId } from '../../../../shared/booleanSettings';
import { INTERPRETER_CLI_COMMAND } from '../../../utils/interpreterCliRuntime';
import { requestInterpreterRuntimeRestart } from '../../../utils/interpreterRuntimeRestart';

const { get, set, cloneDeep, isEqual } = lodash;
const BOOLEAN_UI_SETTING_ID_SET = new Set<string>(BOOLEAN_UI_SETTING_IDS);

interface ApprovalRequirement {
  reason: string;
  settingsPath?: string;
}

type SettingApplyTiming = 'immediate' | 'restartRequired' | 'storedOnly';

interface SettingEffect {
  applyTiming: SettingApplyTiming;
  affectsRunningTurns: boolean;
  canRestartRuntimeNow: boolean;
  restartInterruptsActiveChats: boolean;
  summary: string;
}

function formatApprovalValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  try {
    const serialized = JSON.stringify(value);
    return serialized.length > 240
      ? `${serialized.slice(0, 240)}...[truncated ${serialized.length - 240} chars]`
      : serialized;
  } catch {
    return String(value);
  }
}

function getApprovalRequirement(path: string): ApprovalRequirement | null {
  const normalizedPath = path.trim();

  if (normalizedPath === 'telemetryEnabled') {
    return {
      reason: 'This is a privacy-sensitive setting.',
      settingsPath: 'Settings > General > Privacy',
    };
  }

  if (
    normalizedPath === 'allowAgentAddTools'
    || normalizedPath === 'allowLocalMcpServers'
    || normalizedPath === 'mcpServers'
    || normalizedPath.startsWith('mcpServers.')
  ) {
      return {
        reason: 'This changes which integrations and MCP servers the agent can add or use.',
        settingsPath: 'Settings > Permissions > MCP Permissions',
      };
  }

  if (
    normalizedPath === 'codexNetworkAccess'
    || normalizedPath === 'codexApprovalPolicy'
    || normalizedPath === 'codexSandboxMode'
    || normalizedPath === 'codexReadAccessMode'
    || normalizedPath === 'codexMacosTempAccess'
    || normalizedPath === 'codexMacosScreenshotAccess'
  ) {
    return {
      reason: 'This changes Interpreter runtime access or CLI execution behavior.',
      settingsPath: 'Settings > Permissions > Runtime Permissions',
    };
  }

  if (
    normalizedPath === 'sandboxNetworkAccess'
  ) {
    return {
      reason: 'This changes sandboxed tool network settings.',
      settingsPath: 'Settings > Permissions > Runtime Permissions',
    };
  }

  if (
    normalizedPath === 'codexPath'
    || normalizedPath === 'claudeCodePath'
  ) {
    return {
      reason: 'This changes CLI binary discovery settings.',
    };
  }

  if (
    normalizedPath === 'globalDisabledTools'
    || normalizedPath.startsWith('globalDisabledTools[')
    || normalizedPath === 'builtinToolsEnabled'
    || normalizedPath.startsWith('builtinToolsEnabled.')
  ) {
    return {
      reason: 'This changes which tools are globally available to the agent.',
      settingsPath: 'Settings > Tools',
    };
  }

  if (
    normalizedPath === 'skillFolders'
    || normalizedPath.startsWith('skillFolders[')
    || normalizedPath === 'allowModelSkillEditing'
  ) {
    return {
      reason: 'This changes skill discovery or model skill-editing behavior.',
    };
  }

  if (
    /^profiles\[\d+\]\.disabledTools(?:\.|$)/.test(normalizedPath)
  ) {
    return {
      reason: 'This changes an agent profile\'s allowed tools.',
      settingsPath: 'Settings > Models',
    };
  }

  return null;
}

function getSettingEffect(path: string): SettingEffect | null {
  const normalizedPath = path.trim();

  if (
    normalizedPath === 'codexNetworkAccess'
    || normalizedPath === 'codexSandboxMode'
    || normalizedPath === 'codexReadAccessMode'
    || normalizedPath === 'codexMacosTempAccess'
    || normalizedPath === 'codexMacosScreenshotAccess'
  ) {
    return {
      applyTiming: 'restartRequired',
      affectsRunningTurns: false,
      canRestartRuntimeNow: true,
      restartInterruptsActiveChats: true,
      summary: 'Saved in settings and takes effect after Interpreter restarts. Running turns keep their current runtime policy until then.',
    };
  }

  if (normalizedPath === 'codexApprovalPolicy') {
    return {
      applyTiming: 'immediate',
      affectsRunningTurns: false,
      canRestartRuntimeNow: false,
      restartInterruptsActiveChats: false,
      summary: 'Applies to future approvals immediately. Running turns keep any approval decision already in progress.',
    };
  }

  if (normalizedPath === 'sandboxNetworkAccess') {
    return {
      applyTiming: 'storedOnly',
      affectsRunningTurns: false,
      canRestartRuntimeNow: false,
      restartInterruptsActiveChats: false,
      summary: 'Stored in settings, but the current shared Interpreter runtime does not read this setting.',
    };
  }

  if (
    normalizedPath === 'codexPath'
    || normalizedPath === 'claudeCodePath'
  ) {
    return {
      applyTiming: 'storedOnly',
      affectsRunningTurns: false,
      canRestartRuntimeNow: false,
      restartInterruptsActiveChats: false,
      summary: 'Stored in settings for binary discovery surfaces, but the shared bundled Interpreter runtime does not use this setting.',
    };
  }

  return null;
}

function buildSuccessResponse(
  path: string,
  value: unknown,
  effect?: SettingEffect | null,
  options?: {
    restartRequested?: boolean;
    restartPerformed?: boolean;
    restartDeclined?: boolean;
  },
) {
  const payload: Record<string, unknown> = { success: true, path, value };
  if (effect) {
    payload.effect = {
      ...effect,
      restartRequested: options?.restartRequested ?? false,
      restartPerformed: options?.restartPerformed ?? false,
      restartDeclined: options?.restartDeclined ?? false,
    };
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: false,
  };
}

async function maybeRestartCodexRuntimeForSetting(params: {
  path: string;
  value: unknown;
  effect: SettingEffect | null;
  requested: boolean;
  toolCallId?: string;
  agentId?: string;
}): Promise<{ restartRequested: boolean; restartPerformed: boolean; restartDeclined: boolean }> {
  if (!params.requested || !params.effect?.canRestartRuntimeNow) {
    return { restartRequested: params.requested, restartPerformed: false, restartDeclined: false };
  }

  return requestInterpreterRuntimeRestart({
    approvalToolName: 'interpreter_settings_set',
    approvalServerId: 'builtin-interpreter',
    message: `The setting "${params.path}" was updated. Restart Interpreter's agent runtime now? Restarting will stop running conversations for every agent.`,
    context: {
      setting: params.path,
      newValue: params.value,
    },
    timeoutMs: 30000,
    toolCallId: params.toolCallId,
    agentId: params.agentId,
  });
}

function isBooleanUISettingPath(path: string): path is BooleanUISettingId {
  return BOOLEAN_UI_SETTING_ID_SET.has(path);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isStringBooleanRecord(value: unknown): value is Record<string, boolean> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((item) => typeof item === 'boolean');
}

// Paths that trigger broadcast events with their payload key names
// The payload key must match what the frontend event type expects
const broadcastMap: Record<string, { event: string; payloadKey: string }> = {
  theme: { event: 'theme:changed', payloadKey: 'theme' },
  primaryColor: { event: 'primaryColor:changed', payloadKey: 'color' },
  backgroundOpacity: { event: 'backgroundOpacity:changed', payloadKey: 'opacity' },
  zoomFactor: { event: 'zoomFactor:changed', payloadKey: 'zoomFactor' },
  maxSteps: { event: 'maxSteps:changed', payloadKey: 'maxSteps' },
  maxSubagentDepth: { event: 'maxSubagentDepth:changed', payloadKey: 'maxSubagentDepth' },
  autoContinuationLimit: { event: 'autoContinuationLimit:changed', payloadKey: 'autoContinuationLimit' },
};

export const settingsSetTool: BuiltinToolDefinition = {
  name: 'interpreter_settings_set',
  description:
    `Set Interpreter settings using JS path syntax. Start with \`${INTERPRETER_CLI_COMMAND} config --help\` to see common settings paths and which changes need approval or a restart. Path examples: "theme", "profiles[0].name", "mcpServers.my-server".`,
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'JS-style path to set, e.g. "theme", "profiles[0].name", "mcpServers.my-server"',
      },
      value: {
        description: 'Value to set (string, number, boolean, object, or array)',
      },
      restart_runtime: {
        type: 'boolean',
        description:
          'Optional. When true and the setting supports it, ask whether to restart Interpreter\'s agent runtime after applying the change.',
      },
    },
    required: ['path', 'value'],
  },
  handler: async (args, context?: BuiltinToolContext) => {
    const { path, value, restart_runtime } = args as {
      path: string;
      value: unknown;
      restart_runtime?: boolean;
    };

    try {
      // Block sensitive paths
      if (
        path === 'authToken' ||
        path === 'refreshToken' ||
        path.startsWith('authToken.') ||
        path.startsWith('refreshToken.')
      ) {
        return {
          content: [{ type: 'text', text: 'Cannot modify auth tokens via this tool' }],
          isError: true,
        };
      }

      if (path === 'browserAccessPolicy' || path.startsWith('browserAccessPolicy.')) {
        return {
          content: [
            {
              type: 'text',
              text: 'The browserAccessPolicy setting is read-only for agents. You can read it with interpreter_settings_get, but only the user can change it in Settings > Browser.',
            },
          ],
          isError: true,
        };
      }

      if (path === 'cuaAccessPolicy' || path.startsWith('cuaAccessPolicy.')) {
        return {
          content: [
            {
              type: 'text',
              text: 'The cuaAccessPolicy setting is read-only for agents. You can read it with interpreter_settings_get, but only the user can change it in Settings > Permissions.',
            },
          ],
          isError: true,
        };
      }

      const approvalRequirement = getApprovalRequirement(path);
      const effect = getSettingEffect(path);

      // Check if this path requires user approval
      if (approvalRequirement) {
        const settingsPathHint = approvalRequirement.settingsPath
          ? ` You can review the same control in ${approvalRequirement.settingsPath}.`
          : '';
        const effectHint = effect
          ? ` ${effect.summary}`
          : '';
        try {
          const approved = await approvalManager.createApproval(
            'interpreter_settings_set',
            'builtin-interpreter',
            {
              setting: path,
              newValue: value,
              message: `Let Interpreter change "${path}" to "${formatApprovalValue(value)}"? ${approvalRequirement.reason}${settingsPathHint}${effectHint}`,
            },
            30000, // 30 second timeout
            context?.toolCallId,
            context?.agentId
          );

          if (!approved) {
            return {
              content: [
                {
                  type: 'text',
                  text: `User denied the change to "${path}". The setting was not modified.`,
                },
              ],
              isError: false,
            };
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: 'text',
                text: `Approval request failed or timed out: ${message}. The setting was not modified.`,
              },
            ],
            isError: true,
          };
        }
      }

      // Load config and make a copy to modify
      const config = await configStore.loadConfigWithModelState();
      const modifiedConfig = cloneDeep(config);

      // Apply the change
      set(modifiedConfig as unknown as Record<string, unknown>, path, value);

      if (!isEqual(get(modifiedConfig, 'browserAccessPolicy'), get(config, 'browserAccessPolicy'))) {
        return {
          content: [
            {
              type: 'text',
              text: 'The browserAccessPolicy setting is read-only for agents. You can read it with interpreter_settings_get, but only the user can change it in Settings > Browser.',
            },
          ],
          isError: true,
        };
      }

      if (!isEqual(get(modifiedConfig, 'cuaAccessPolicy'), get(config, 'cuaAccessPolicy'))) {
        return {
          content: [
            {
              type: 'text',
              text: 'The cuaAccessPolicy setting is read-only for agents. You can read it with interpreter_settings_get, but only the user can change it in Settings > Permissions.',
            },
          ],
          isError: true,
        };
      }

      // Validate the ENTIRE config against schema
      const validation = validateConfig(modifiedConfig);
      if (!validation.success) {
        return {
          content: [
            {
              type: 'text',
              text: `Invalid config after change:\n${validation.error}`,
            },
          ],
          isError: true,
        };
      }

      // Validate builtin profiles aren't being deleted
      // The agent sees merged profiles (builtins + custom) from interpreter_get
      // If they try to set profiles to something missing builtins, reject it
      if (path === 'profiles') {
        // Agent is replacing the entire profiles array
        // The value they provide should include all builtin profiles
        const builtinIds = new Set(BUILTIN_PROFILES.map(p => p.id));
        const newProfiles = Array.isArray(value) ? value as { id?: string }[] : [];
        const newIds = new Set(newProfiles.map(p => p.id).filter(Boolean));

        const missingBuiltins = [...builtinIds].filter(id => !newIds.has(id));
        if (missingBuiltins.length > 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Invalid config: Cannot delete builtin profiles. Missing: ${missingBuiltins.join(', ')}. Builtin profiles (Smart, Fast, Claude Code, Gemini CLI) cannot be removed.`,
              },
            ],
            isError: true,
          };
        }
      } else if (path.match(/^profiles\[\d+\]$/)) {
        // Agent is replacing a specific profile by index
        // Get the current merged profiles to see which one they're targeting
        const currentProfiles = await configStore.getAllProfiles();
        const indexMatch = path.match(/^profiles\[(\d+)\]$/);
        const index = indexMatch ? parseInt(indexMatch[1], 10) : -1;

        if (index >= 0 && index < currentProfiles.length) {
          const targetProfile = currentProfiles[index];
          if (targetProfile.isBuiltin && value === null) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Invalid config: Cannot delete builtin profile "${targetProfile.id}". Builtin profiles cannot be removed.`,
                },
              ],
              isError: true,
            };
          }
        }
      }

      // Validate builtin providers aren't being deleted
      // Same pattern as profiles - agent sees merged providers from interpreter_get
      if (path === 'providers') {
        // Agent is replacing the entire providers object
        const builtinIds = new Set(BUILTIN_PROVIDERS.map(p => p.id));
        const newProviders = (typeof value === 'object' && value !== null)
          ? value as Record<string, { id?: string }>
          : {};
        const newIds = new Set(Object.keys(newProviders));

        const missingBuiltins = [...builtinIds].filter(id => !newIds.has(id));
        if (missingBuiltins.length > 0) {
          return {
            content: [
              {
                type: 'text',
                text: `Invalid config: Cannot delete builtin providers. Missing: ${missingBuiltins.join(', ')}. Builtin providers cannot be removed.`,
              },
            ],
            isError: true,
          };
        }
      } else if (path.match(/^providers\.[^.]+$/)) {
        // Agent is setting a specific provider (providers.builtin:hosted)
        // Extract the provider ID from the path
        const providerId = path.replace('providers.', '');
        if (isBuiltinProvider(providerId) && (value === null || value === undefined)) {
          return {
            content: [
              {
                type: 'text',
                text: `Invalid config: Cannot delete builtin provider "${providerId}". Builtin providers cannot be removed.`,
              },
            ],
            isError: true,
          };
        }
      }

      const rootPath = path.split('.')[0].split('[')[0];

      if (path === 'theme') {
        await setThemeHandler(value as 'light' | 'dark' | 'system');
        return buildSuccessResponse(path, value, effect);
      }

      if (path === 'language') {
        const result = await setLanguageHandler(String(value));
        if (!result.success) {
          return {
            content: [{ type: 'text', text: result.error ?? 'Failed to set language.' }],
            isError: true,
          };
        }
        return buildSuccessResponse(path, value, effect);
      }

      if (path === 'primaryColor') {
        await setPrimaryColorHandler(String(value));
        return buildSuccessResponse(path, value, effect);
      }

      if (path === 'backgroundOpacity') {
        await setBackgroundOpacityHandler(Number(value));
        return buildSuccessResponse(path, value, effect);
      }

      if (path === 'maxSteps') {
        await setMaxStepsHandler(Number(value));
        return buildSuccessResponse(path, value, effect);
      }

      if (path === 'maxSubagentDepth') {
        await setMaxSubagentDepthHandler(Number(value));
        return buildSuccessResponse(path, value, effect);
      }

      if (path === 'autoContinuationLimit') {
        await setAutoContinuationLimitHandler(Number(value));
        return buildSuccessResponse(path, value, effect);
      }

      if (isBooleanUISettingPath(path)) {
        const nextValue = Boolean(value);
        await setBooleanUISettingHandler(path, nextValue);
        return buildSuccessResponse(path, nextValue, effect);
      }

      if (path === 'telemetryEnabled') {
        const nextValue = Boolean(value);
        await configStore.setTelemetryEnabled(nextValue);
        return buildSuccessResponse(path, nextValue, effect);
      }

      if (path === 'allowAgentAddTools') {
        const nextValue = Boolean(value);
        await setAllowAgentAddToolsHandler(nextValue);
        return buildSuccessResponse(path, nextValue, effect);
      }

      if (path === 'allowLocalMcpServers') {
        const nextValue = Boolean(value);
        await setAllowLocalMcpServersHandler(nextValue);
        return buildSuccessResponse(path, nextValue, effect);
      }

      if (rootPath === 'skillFolders') {
        const nextFolders = get(modifiedConfig, 'skillFolders');
        if (!isStringArray(nextFolders)) {
          return {
            content: [{ type: 'text', text: 'skillFolders must be an array of strings.' }],
            isError: true,
          };
        }
        await setSkillFoldersHandler(nextFolders);
        return buildSuccessResponse(path, nextFolders, effect);
      }

      if (path === 'allowModelSkillEditing') {
        const nextValue = Boolean(value);
        await setAllowModelSkillEditingHandler(nextValue);
        return buildSuccessResponse(path, nextValue, effect);
      }

      if (path === 'codexNetworkAccess') {
        const nextValue = Boolean(value);
        await configStore.setCodexNetworkAccess(nextValue);
        const restartOutcome = await maybeRestartCodexRuntimeForSetting({
          path,
          value: nextValue,
          effect,
          requested: Boolean(restart_runtime),
          toolCallId: context?.toolCallId,
          agentId: context?.agentId,
        });
        return buildSuccessResponse(path, nextValue, effect, restartOutcome);
      }

      if (path === 'sandboxNetworkAccess') {
        const nextValue = Boolean(value);
        await configStore.setSandboxNetworkAccess(nextValue);
        return buildSuccessResponse(path, nextValue, effect);
      }

      if (path === 'codexApprovalPolicy') {
        await configStore.setCodexApprovalPolicy(value as configStore.CodexApprovalPolicy);
        const restartOutcome = await maybeRestartCodexRuntimeForSetting({
          path,
          value,
          effect,
          requested: Boolean(restart_runtime),
          toolCallId: context?.toolCallId,
          agentId: context?.agentId,
        });
        return buildSuccessResponse(path, value, effect, restartOutcome);
      }

      if (path === 'codexSandboxMode') {
        await configStore.setCodexSandboxMode(value as configStore.CodexSandboxMode);
        const restartOutcome = await maybeRestartCodexRuntimeForSetting({
          path,
          value,
          effect,
          requested: Boolean(restart_runtime),
          toolCallId: context?.toolCallId,
          agentId: context?.agentId,
        });
        return buildSuccessResponse(path, value, effect, restartOutcome);
      }

      if (path === 'codexReadAccessMode') {
        await configStore.setCodexReadAccessMode(value as configStore.CodexReadAccessMode);
        const restartOutcome = await maybeRestartCodexRuntimeForSetting({
          path,
          value,
          effect,
          requested: Boolean(restart_runtime),
          toolCallId: context?.toolCallId,
          agentId: context?.agentId,
        });
        return buildSuccessResponse(path, value, effect, restartOutcome);
      }

      if (path === 'codexMacosTempAccess') {
        const nextValue = Boolean(value);
        await configStore.setCodexMacosTempAccess(nextValue);
        const restartOutcome = await maybeRestartCodexRuntimeForSetting({
          path,
          value: nextValue,
          effect,
          requested: Boolean(restart_runtime),
          toolCallId: context?.toolCallId,
          agentId: context?.agentId,
        });
        return buildSuccessResponse(path, nextValue, effect, restartOutcome);
      }

      if (path === 'codexMacosScreenshotAccess') {
        const nextValue = Boolean(value);
        await configStore.setCodexMacosScreenshotAccess(nextValue);
        const restartOutcome = await maybeRestartCodexRuntimeForSetting({
          path,
          value: nextValue,
          effect,
          requested: Boolean(restart_runtime),
          toolCallId: context?.toolCallId,
          agentId: context?.agentId,
        });
        return buildSuccessResponse(path, nextValue, effect, restartOutcome);
      }

      if (rootPath === 'globalDisabledTools') {
        const nextDisabledTools = get(modifiedConfig, 'globalDisabledTools');
        if (!isStringArray(nextDisabledTools)) {
          return {
            content: [{ type: 'text', text: 'globalDisabledTools must be an array of strings.' }],
            isError: true,
          };
        }
        await configStore.setGlobalDisabledTools(nextDisabledTools);
        return buildSuccessResponse(path, nextDisabledTools, effect);
      }

      if (path === 'builtinToolsEnabled') {
        const nextEnabledMap = get(modifiedConfig, 'builtinToolsEnabled');
        if (!isStringBooleanRecord(nextEnabledMap)) {
          return {
            content: [{ type: 'text', text: 'builtinToolsEnabled must be an object mapping tool IDs to booleans.' }],
            isError: true,
          };
        }

        const currentEnabledMap = config.builtinToolsEnabled ?? {};
        const serverIds = new Set([
          ...Object.keys(currentEnabledMap),
          ...Object.keys(nextEnabledMap),
        ]);

        for (const serverId of serverIds) {
          const nextValue = nextEnabledMap[serverId] ?? true;
          const currentValue = currentEnabledMap[serverId] ?? true;
          if (nextValue !== currentValue) {
            await globalToolsHandlers.setGlobalToolEnabled(serverId, nextValue);
          }
        }

        return buildSuccessResponse(path, nextEnabledMap, effect);
      }

      if (path.startsWith('builtinToolsEnabled.')) {
        const serverId = path.slice('builtinToolsEnabled.'.length);
        const nextValue = Boolean(value);
        await globalToolsHandlers.setGlobalToolEnabled(serverId, nextValue);
        return buildSuccessResponse(path, nextValue, effect);
      }

      // Config is valid - save it
      await configStore.saveConfig(modifiedConfig);

      // Broadcast if this path has an event
      const broadcastInfo = broadcastMap[rootPath];
      if (broadcastInfo) {
        const eventValue = get(modifiedConfig, rootPath);
        broadcastEvent(broadcastInfo.event, { [broadcastInfo.payloadKey]: eventValue });
      }

      return buildSuccessResponse(path, value, effect);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to set setting: ${message}` }],
        isError: true,
      };
    }
  },
};
