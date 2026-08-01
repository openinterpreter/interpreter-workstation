import {
  DEFAULT_CODEX_READ_ACCESS_MODE,
  DEFAULT_CODEX_SANDBOX_MODE,
  type CodexReadAccessMode,
  type CodexSandboxMode,
} from './sandbox-policy';

export {
  DEFAULT_CODEX_READ_ACCESS_MODE,
  DEFAULT_CODEX_SANDBOX_MODE,
};
export type {
  CodexReadAccessMode,
  CodexSandboxMode,
};

export const CODEX_SANDBOX_MODE_CHANGED_EVENT = 'codex-native-tools:sandbox-mode-changed';

export const CODEX_SANDBOX_MODE_OPTIONS: Array<{
  value: CodexSandboxMode;
  label: string;
  description: string;
}> = [
  { value: 'read-only', label: 'Read Only', description: 'Interpreter can inspect files but cannot write.' },
  { value: 'workspace-write', label: 'Workspace Write', description: 'Interpreter can write in the active folder.' },
  { value: 'danger-full-access', label: 'Full Access', description: 'Interpreter can read and write outside your open folder.' },
];

export const CODEX_READ_ACCESS_MODE_OPTIONS: Array<{
  value: CodexReadAccessMode;
  label: string;
  description: string;
}> = [
  { value: 'workspace-only', label: 'Folder Only', description: 'Interpreter reads files from the active folder only.' },
  { value: 'full-system', label: 'Full System', description: 'Interpreter can inspect files outside your open folder.' },
];

export function getCodexReadAccessNotice(
  mode: CodexReadAccessMode | null | undefined,
  sandboxMode: CodexSandboxMode | null | undefined,
): {
  label: string;
  description: string;
  tone: 'neutral' | 'warning';
} | null {
  if (sandboxMode === 'danger-full-access') {
    return {
      label: 'Full access overrides read scope',
      description: 'Full Access always allows reading and writing outside your open folder.',
      tone: 'warning',
    };
  }

  if (!mode || mode === DEFAULT_CODEX_READ_ACCESS_MODE) {
    return null;
  }

  return {
    label: 'Folder-only reads',
    description: 'Interpreter reads user files from the active folder only.',
    tone: 'neutral',
  };
}

export function getCodexSandboxNotice(mode: CodexSandboxMode | null | undefined): {
  label: string;
  description: string;
  tone: 'neutral' | 'warning';
} | null {
  if (!mode || mode === DEFAULT_CODEX_SANDBOX_MODE) {
    return null;
  }

  if (mode === 'read-only') {
    return {
      label: 'Read only',
      description: 'Interpreter can inspect files but cannot write.',
      tone: 'neutral',
    };
  }

  return {
    label: 'Full access',
    description: 'Interpreter can read and write outside your open folder.',
    tone: 'warning',
  };
}

export function getCodexWorkspaceDescription(
  mode: CodexSandboxMode | null | undefined,
  workspaceLabel: string | null | undefined,
): string {
  if (!workspaceLabel) {
    if (mode === 'read-only') {
      return 'Choose a folder. Interpreter will be able to read files there, but not edit them.';
    }
    if (mode === 'danger-full-access') {
      return 'Choose a starting folder. Interpreter can read and write anywhere in Full access mode.';
    }
    return 'Choose the folder Interpreter should work in.';
  }

  if (mode === 'read-only') {
    return `Interpreter can read files in ${workspaceLabel}, but cannot edit them in Read only mode.`;
  }
  if (mode === 'danger-full-access') {
    return `Interpreter starts in ${workspaceLabel}. In Full access mode, it can also read and write outside this folder.`;
  }
  return `Interpreter can edit files in ${workspaceLabel}.`;
}
