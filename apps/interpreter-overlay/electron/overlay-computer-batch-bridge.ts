import { getBuiltinToolHandlerIncludingHidden } from '../../../server/tools/builtinTools';
import { callTool as callInterpreterTool } from '../../../server/handlers/toolServers';
import { repairComputerBatchArguments } from '../../../server/utils/computerBatchArgumentRepair';
import { listOverlayRealtimeCompatibleToolNames } from '../../../shared/types/overlayToolCatalog';
import type { AgentModelConfig } from '../../../shared/types/model';
import type { ToolCallResponse } from '../../../server/tools/toolTypes';
import type { ComputerBatchParams, ToolExecutionResult } from '../shared/ports.js';
import type { OverlayRegionContextItem } from '../shared/ipc.js';
import { executeAdvancedVoiceComputerBatchToolCall } from './advanced-voice-interpreter-tool.js';
import { buildOverlayToolManagerIdentity } from './overlay-tool-identity.js';
import { committedTargetWindowClosedMessage } from './attached-target-context.js';

export interface OverlayComputerBatchBridgeCallOptions {
  argumentsJson: string;
  agentId: string;
  workspacePath: string | null;
  profileId: string;
  modelConfig: AgentModelConfig;
  /**
   * The committed selected-target context, when the controller is bound to
   * one. A dead committed target window turns the whole batch into a
   * target_window_closed tool result instead of executing, for both the
   * voice and typed transports.
   */
  targetContext: OverlayRegionContextItem | null;
  callSelectedTargetBatch: (params: ComputerBatchParams) => Promise<ToolCallResponse>;
}

/**
 * Shared production wiring for the realtime/typed controller computer_batch
 * bridge: the same executor, ToolManager identity, review-backed
 * selected-target batch callback, dead-target observation, and fast repair
 * model for both the advanced voice controller and the typed fast text
 * controller loop.
 */
export async function callOverlayComputerBatchBridgeTool(
  options: OverlayComputerBatchBridgeCallOptions,
): Promise<string> {
  const closedMessage = options.targetContext
    ? await committedTargetWindowClosedMessage(options.targetContext)
    : null;
  if (closedMessage) {
    console.warn('[InterpreterOverlay] [COMPUTER_BATCH] dead-target-observation', {
      at: 'computer_batch',
      message: closedMessage,
    });
    return JSON.stringify({ status: 'target_window_closed', message: closedMessage });
  }
  return await executeAdvancedVoiceComputerBatchToolCall({
    argumentsJson: options.argumentsJson,
    // The realtime-compatible allowlist is the gate; several allowed servers
    // (builtin-interpreter-overlay, builtin-agent-windows) are hidden from
    // general discovery, so resolution must include hidden builtins or the
    // advertised tools fail as unknown_tool.
    getBuiltinTool: getBuiltinToolHandlerIncludingHidden,
    callTool: async (serverId, toolName, args) => await callInterpreterTool(
      serverId,
      toolName,
      args,
      false,
      buildOverlayToolManagerIdentity({
        agentId: options.agentId,
        workspacePath: options.workspacePath,
        profileId: options.profileId,
        modelConfig: options.modelConfig,
      }),
      { includeHiddenBuiltins: true },
    ) as ToolCallResponse,
    callSelectedTargetBatch: options.callSelectedTargetBatch,
    repairArguments: async (rawArgumentsJson, parseError) => {
      const decision = await repairComputerBatchArguments({
        argumentsJson: rawArgumentsJson,
        parseError,
        allowedToolNames: listOverlayRealtimeCompatibleToolNames(),
      });
      return decision.kind === 'repaired' ? decision.argumentsJson : null;
    },
  });
}

export function formatOverlaySelectedTargetBatchResult(
  result: ToolExecutionResult | undefined,
): string {
  if (!result) {
    return 'Action completed successfully';
  }
  if (result.kind === 'text') {
    return result.text;
  }
  if (result.kind === 'structured-screen') {
    return `Action completed. The executor observed ${result.snapshot.elements.length} elements after the batch; changes are reported in touched_window_diff.`;
  }
  return [
    'Action completed. A fresh target screenshot was captured.',
    `Screenshot id: ${result.screenshotId}`,
  ].join('\n');
}
