import type { Profile } from '../../shared/types/profile';
import { TERMINAL_AGENTS } from '../../shared/terminalAgents';

export const AUTO_CLAUDE_CODE_TERMINAL_PROFILE_ID = 'auto:claude-code-terminal';
const AUTO_CLAUDE_CODE_INPUT_MARKER = '❯';

interface AutomaticProfileState {
  profiles?: Profile[];
  dismissedAutomaticProfileIds?: string[];
}

function isManualClaudeCodeTerminalProfile(profile: Profile): boolean {
  if (profile.provider !== 'terminal') {
    return false;
  }

  const terminalConfig = profile.providerConfig;
  return terminalConfig?.id === 'claude-code'
    || terminalConfig?.command === TERMINAL_AGENTS['claude-code'].command;
}

export function hasAutomaticOrManualClaudeCodeTerminalProfile(profiles: Profile[]): boolean {
  return profiles.some((profile) =>
    profile.id === AUTO_CLAUDE_CODE_TERMINAL_PROFILE_ID
    || isManualClaudeCodeTerminalProfile(profile),
  );
}

export function buildAutomaticClaudeCodeTerminalProfile(): Profile {
  const claudeCode = TERMINAL_AGENTS['claude-code'];

  return {
    id: AUTO_CLAUDE_CODE_TERMINAL_PROFILE_ID,
    name: claudeCode.name,
    provider: 'terminal',
    modelId: claudeCode.id,
    isBuiltin: false,
    providerConfig: {
      id: claudeCode.id,
      command: claudeCode.command,
      icon: claudeCode.icon,
      richInput: false,
      hideInput: true,
      inputMarker: AUTO_CLAUDE_CODE_INPUT_MARKER,
      titleMarker: claudeCode.titleMarker,
      helpDescription: claudeCode.helpDescription,
    },
  };
}

export function shouldEnsureAutomaticClaudeCodeTerminalProfile(
  state: AutomaticProfileState,
  claudeCodeInstalled: boolean,
): boolean {
  if (!claudeCodeInstalled) {
    return false;
  }

  if ((state.dismissedAutomaticProfileIds ?? []).includes(AUTO_CLAUDE_CODE_TERMINAL_PROFILE_ID)) {
    return false;
  }

  return !hasAutomaticOrManualClaudeCodeTerminalProfile(state.profiles ?? []);
}

export function rememberDismissedAutomaticProfile(
  profileId: string,
  dismissedAutomaticProfileIds?: string[],
): string[] | undefined {
  if (profileId !== AUTO_CLAUDE_CODE_TERMINAL_PROFILE_ID) {
    return dismissedAutomaticProfileIds;
  }

  const nextDismissedAutomaticProfileIds = new Set(dismissedAutomaticProfileIds ?? []);
  nextDismissedAutomaticProfileIds.add(profileId);
  return [...nextDismissedAutomaticProfileIds];
}
