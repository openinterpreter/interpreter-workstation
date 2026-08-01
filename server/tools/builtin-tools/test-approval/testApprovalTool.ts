// Test Approval Tool
// A test tool that requires user approval before executing

import type { BuiltinToolDefinition, BuiltinToolContext } from '../../builtinTools';
import { approvalManager } from '../../../approvalManager';

export const testApprovalTool: BuiltinToolDefinition = {
  name: 'test_approval',
  description: 'A test tool that requires user approval before executing. Used to test the approval system.',
  inputSchema: {
    type: 'object',
    properties: {
      message: {
        type: 'string',
        description: 'A test message to include in the response',
        default: 'Test approval executed successfully'
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds for the approval request (default: 30000)',
        default: 30000
      }
    },
    required: []
  },
  handler: async (args: Record<string, any>, context?: BuiltinToolContext) => {
    const message = args.message || 'Test approval executed successfully';
    const timeout = typeof args.timeout === 'number' ? args.timeout : 30000;
    const toolCallId = context?.toolCallId;

    try {
      // Create approval request and wait for user response
      const approved = await approvalManager.createApproval(
        'test_approval',
        'builtin-test-approval',
        { message, timeout },
        timeout,
        toolCallId,
        context?.agentId
      );

      if (approved) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              approved: true,
              message: message,
              timestamp: new Date().toISOString()
            }, null, 2)
          }],
          isError: false
        };
      } else {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              approved: false,
              denied: true,
              message: 'Tool was denied by user',
              timestamp: new Date().toISOString()
            }, null, 2)
          }],
          isError: false
        };
      }
    } catch (error: any) {
      // Handle timeout or other errors
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            approved: false,
            error: error.message,
            message: 'Approval request failed or timed out',
            timestamp: new Date().toISOString()
          }, null, 2)
        }],
        isError: true
      };
    }
  }
};
