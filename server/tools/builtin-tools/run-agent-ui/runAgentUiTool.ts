// Run Agent UI Tool
// A builtin tool that opens a visible UI agent tab and returns metadata once the renderer has opened it.

import type { BuiltinToolDefinition, BuiltinToolContext } from '../../builtinTools';
import { startAgentTask } from '../../../agentTaskService';

export const runAgentUiTool: BuiltinToolDefinition = {
  name: 'run_agent_ui',
  description: 'Creates a new agent tab in the UI and returns tab metadata after the renderer opens it. Unlike run_agent, this creates a visible tab for the user to see.',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'The user message to send to the agent'
      },
      system: {
        type: 'string',
        description: 'Optional system prompt to configure the agent behavior'
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds for the agent execution (default: 120000 = 2 minutes)',
        default: 120000
      },
      closeTabAfterCompletion: {
        type: 'boolean',
        description: 'Close the headed agent tab automatically after the requested task finishes.',
        default: false,
      }
    },
    required: ['message']
  },
  handler: async (args: Record<string, any>, context?: BuiltinToolContext) => {
    const message = args.message;
    const system = args.system;
    const timeout = args.timeout || 120000;
    const closeTabAfterCompletion = args.closeTabAfterCompletion === true;

    console.log('[RunAgentUiTool] Creating agent tab with:', {
      message,
      system,
      timeout,
      closeTabAfterCompletion,
      workspace: context?.workspace ?? null,
      hasModelConfig: Boolean(context?.modelConfig),
    });

    try {
      const result = await startAgentTask({
        mode: 'headed',
        message,
        system,
        timeoutMs: timeout,
        modelConfig: context?.modelConfig,
        workspace: context?.workspace,
        completionDisposition: closeTabAfterCompletion ? 'close_tab' : 'keep_open',
      });

      console.log('[RunAgentUiTool] Agent tab opened:', {
        messageCount: result.messages.length,
        agentId: result.agentId,
        threadId: result.threadId,
      });

      // Format the messages for output
      const formattedMessages = result.messages.map((msg: any, idx: number) => {
        // Extract text from parts (UIMessage structure)
        const textParts = msg.parts?.filter((p: any) => p.type === 'text') || [];
        const text = textParts.map((p: any) => p.text).join('\n') || undefined;

        return {
          index: idx,
          id: msg.id,
          role: msg.role,
          text,
          parts: msg.parts || undefined
        };
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            mode: result.mode,
            agentId: result.agentId,
            threadId: result.threadId,
            messageCount: result.messages.length,
            messages: formattedMessages
          }, null, 2)
        }],
        isError: false
      };

    } catch (error: any) {
      console.error('[RunAgentUiTool] Error creating agent tab:', error);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message || 'Failed to create agent tab',
            timestamp: new Date().toISOString()
          }, null, 2)
        }],
        isError: true
      };
    }
  }
};
