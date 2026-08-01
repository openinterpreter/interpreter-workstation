// Run Agent Tool
// A builtin tool that creates a new agent, sends a message, and returns the full thread

import type { BuiltinToolDefinition, BuiltinToolContext } from '../../builtinTools';
import { startAgentTask } from '../../../agentTaskService';

export const runAgentTool: BuiltinToolDefinition = {
  name: 'run_agent',
  description: 'Creates a new agent instance, sends a message, waits for completion, and returns the full message thread. Use this to delegate complex tasks to a separate agent that can use tools and reason independently.',
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
      }
    },
    required: ['message']
  },
  handler: async (args: Record<string, any>, context?: BuiltinToolContext) => {
    const message = args.message;
    const system = args.system;
    const timeout = args.timeout || 120000;

    // Inherit model from parent context (required)
    const modelConfig = context?.modelConfig;
    if (!modelConfig) {
      return {
        content: [{
          type: 'text',
          text: 'Error: No model configuration provided from parent context'
        }],
        isError: true
      };
    }

    console.log('[RunAgentTool] Starting agent execution with:', {
      messageLength: typeof message === 'string' ? message.length : 0,
      hasSystemPrompt: typeof system === 'string' && system.length > 0,
      timeout,
      workspace: context?.workspace ?? null,
      modelConfig: {
        provider: modelConfig.provider,
        modelId: modelConfig.modelId,
        apiFormat: modelConfig.apiFormat,
        baseURL: modelConfig.baseURL,
        hasApiKey: !!modelConfig.apiKey,
      },
    });

    try {
      const result = await startAgentTask({
        mode: 'headless',
        message,
        system,
        modelConfig,
        timeoutMs: timeout,
        workspace: context?.workspace,
      });

      console.log('[RunAgentTool] Agent execution result:', {
        agentId: result.agentId,
        completed: result.completed,
        messageCount: result.messages.length,
        error: result.error
      });

      if (!result.completed) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: result.error || 'Agent execution did not complete',
              agentId: result.agentId,
              timestamp: result.timestamp
            }, null, 2)
          }],
          isError: true
        };
      }

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
            timestamp: result.timestamp,
            messageCount: result.messages.length,
            messages: formattedMessages
          }, null, 2)
        }],
        isError: false
      };

    } catch (error: any) {
      console.error('[RunAgentTool] Error running agent:', error);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message || 'Failed to run agent',
            timestamp: new Date().toISOString()
          }, null, 2)
        }],
        isError: true
      };
    }
  }
};
