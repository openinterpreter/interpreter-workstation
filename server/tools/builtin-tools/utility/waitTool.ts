import type { BuiltinToolDefinition } from '../../builtinTools';

export const waitTool: BuiltinToolDefinition = {
  name: 'wait',
  description: 'Wait for a specified number of seconds. Use this when you need to pause before checking on a background operation, or when an external process needs time to complete.',
  inputSchema: {
    type: 'object',
    properties: {
      seconds: {
        type: 'number',
        description: 'Number of seconds to wait (max 300 seconds / 5 minutes)'
      },
      reason: {
        type: 'string',
        description: 'Optional reason for waiting (for logging purposes)'
      }
    },
    required: ['seconds']
  },
  handler: async (args: Record<string, any>) => {
    const seconds = Math.min(Math.max(0, args.seconds || 0), 300); // Clamp between 0 and 300
    const reason = args.reason || 'No reason specified';

    console.log(`[wait] Waiting ${seconds} seconds. Reason: ${reason}`);

    await new Promise(resolve => setTimeout(resolve, seconds * 1000));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          waited_seconds: seconds,
          reason: reason
        }, null, 2)
      }],
      isError: false
    };
  }
};
