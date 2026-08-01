// Echo Secret Tool - Simple tool for testing that echoes back a secret message
import type { BuiltinToolDefinition } from '../../builtinTools';

export const echoSecretTool: BuiltinToolDefinition = {
  name: 'echo_secret',
  description: 'Echoes back a secret message. Used for testing tool execution.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      secret: {
        type: 'string',
        description: 'The secret message to echo back',
      },
    },
    required: ['secret'],
  },
  handler: async (args: Record<string, any>) => {
    const { secret } = args;

    if (!secret || typeof secret !== 'string') {
      throw new Error('secret parameter is required and must be a string');
    }

    // Add a 2-second delay to allow UI to update and tests to catch intermediate states
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Echo back the secret
    const message = `Echoed secret: ${secret}`;

    return {
      content: [
        {
          type: 'text' as const,
          text: message,
        },
      ],
      isError: false,
    };
  },
};
