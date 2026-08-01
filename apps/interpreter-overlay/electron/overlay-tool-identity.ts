import type { AgentModelConfig } from '../../../shared/types/model';

export interface OverlayToolManagerIdentityInput {
  agentId: string;
  workspacePath: string | null;
  profileId: string | null;
  modelConfig?: AgentModelConfig;
  overlayReviewedAction?: boolean;
}

export interface OverlayBuiltinToolIdentityInput<TModelConfig> {
  agentId: string;
  workspacePath: string | null;
  modelConfig: TModelConfig;
}

export interface OverlayToolSessionIdentityInput {
  agentId: string;
  callerToken: string;
  workspacePath: string | null;
  windowSessionKey: string | null;
}

export function buildOverlayToolManagerIdentity(input: OverlayToolManagerIdentityInput): {
  callerTabId: string;
  workspace?: string;
  profileId?: string;
  modelConfig?: AgentModelConfig;
  overlayReviewedAction?: boolean;
} {
  return {
    callerTabId: input.agentId,
    ...(input.workspacePath ? { workspace: input.workspacePath } : {}),
    ...(input.profileId ? { profileId: input.profileId } : {}),
    ...(input.modelConfig ? { modelConfig: input.modelConfig } : {}),
    ...(input.overlayReviewedAction ? { overlayReviewedAction: true } : {}),
  };
}

export function buildOverlayBuiltinToolIdentity<TModelConfig>(
  input: OverlayBuiltinToolIdentityInput<TModelConfig>,
): {
  agentId: string;
  workspace?: string;
  modelConfig: TModelConfig;
} {
  return {
    agentId: input.agentId,
    ...(input.workspacePath ? { workspace: input.workspacePath } : {}),
    modelConfig: input.modelConfig,
  };
}

export function buildOverlayToolSessionIdentity(input: OverlayToolSessionIdentityInput): {
  agentId: string;
  callerToken: string;
  workspacePath: string | null;
  windowSessionKey: string | null;
} {
  return {
    agentId: input.agentId,
    callerToken: input.callerToken,
    workspacePath: input.workspacePath,
    windowSessionKey: input.windowSessionKey,
  };
}
