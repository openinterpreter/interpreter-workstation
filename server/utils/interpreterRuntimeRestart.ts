import { approvalManager } from '../approvalManager';
import { broadcastEvent } from '../handlers/broadcast';
import { IPC_CHANNELS } from '../../electron/ipc/registry';
import {
  getRunningAgentCount,
  stopAllRunningAgents,
} from './runningAgentRegistry';

const RUNTIME_RESTART_CLIENT_STOP_GRACE_MS = 500;

export type InterpreterRuntimeRestartOutcome = {
  restartRequested: boolean;
  restartPerformed: boolean;
  restartDeclined: boolean;
  stoppedAgentCount?: number;
};

export async function requestInterpreterRuntimeRestart(params: {
  approvalToolName: string;
  approvalServerId: string;
  message: string;
  context?: Record<string, unknown>;
  toolCallId?: string;
  agentId?: string;
  timeoutMs?: number;
}): Promise<InterpreterRuntimeRestartOutcome> {
  const approved = await approvalManager.createApproval(
    params.approvalToolName,
    params.approvalServerId,
    {
      ...params.context,
      message: params.message,
      runtimeRestart: true,
      runtimeRestartNotice: 'Restarting stops running conversations for every agent.',
    },
    params.timeoutMs ?? 30000,
    params.toolCallId,
    params.agentId,
  );

  if (!approved) {
    return {
      restartRequested: true,
      restartPerformed: false,
      restartDeclined: true,
    };
  }

  const runningAgentCount = getRunningAgentCount();
  broadcastEvent(IPC_CHANNELS.RUNTIME_RESTARTING, {
    requestedAt: Date.now(),
    runningAgentCount,
  });

  if (runningAgentCount > 0) {
    await new Promise((resolve) => setTimeout(resolve, RUNTIME_RESTART_CLIENT_STOP_GRACE_MS));
  }

  const stoppedAgentIds = await stopAllRunningAgents();

  const { restartCodexRuntime } = await import('../../src/lib/codex/service');
  restartCodexRuntime();
  broadcastEvent(IPC_CHANNELS.RUNTIME_RESTARTED, {
    restartedAt: Date.now(),
    stoppedAgentCount: stoppedAgentIds.length,
  });

  return {
    restartRequested: true,
    restartPerformed: true,
    restartDeclined: false,
    stoppedAgentCount: stoppedAgentIds.length,
  };
}
