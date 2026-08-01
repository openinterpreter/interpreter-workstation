export type ToolServerStateLike = {
  status: 'disconnected' | 'connecting' | 'connected' | 'failed';
  tools?: ReadonlyArray<unknown> | null;
  resources?: ReadonlyArray<unknown> | null;
  prompts?: ReadonlyArray<unknown> | null;
  needsAuth?: boolean;
  error?: string;
};

export type RemoteToolServerSetupPhase = 'needs-auth' | 'connected' | 'failed' | null;

function getItemCount(items: ReadonlyArray<unknown> | null | undefined): number {
  return Array.isArray(items) ? items.length : 0;
}

export function getToolServerCapabilityCount(
  state: ToolServerStateLike | null | undefined,
): number {
  if (!state || state.status !== 'connected') {
    return 0;
  }

  return (
    getItemCount(state.tools)
    + getItemCount(state.resources)
    + getItemCount(state.prompts)
  );
}

export function getToolServerToolCount(
  state: ToolServerStateLike | null | undefined,
): number {
  if (!state || state.status !== 'connected') {
    return 0;
  }

  return getItemCount(state.tools);
}

export function isToolServerAuthRequired(
  state: ToolServerStateLike | null | undefined,
): boolean {
  return state?.status === 'failed' && state.needsAuth === true;
}

export function isRemoteToolServerDisplayConnected(
  state: ToolServerStateLike | null | undefined,
): boolean {
  return state?.status === 'connected' && getToolServerCapabilityCount(state) > 0;
}

export function isToolServerDisplayConnected(params: {
  state: ToolServerStateLike | null | undefined;
  isBuiltin?: boolean;
}): boolean {
  if (!params.state) {
    return false;
  }

  if (params.isBuiltin) {
    return params.state.status === 'connected';
  }

  return isRemoteToolServerDisplayConnected(params.state);
}

export function isToolServerAgentAccessible(
  state: ToolServerStateLike | null | undefined,
): boolean {
  return state?.status === 'connected' && getToolServerToolCount(state) > 0;
}

export function resolveRemoteToolServerSetupPhase(
  state: ToolServerStateLike | null | undefined,
): RemoteToolServerSetupPhase {
  if (!state) {
    return null;
  }

  if (isToolServerAuthRequired(state)) {
    return 'needs-auth';
  }

  if (isRemoteToolServerDisplayConnected(state)) {
    return 'connected';
  }

  if (state.status === 'failed') {
    return 'failed';
  }

  return null;
}
