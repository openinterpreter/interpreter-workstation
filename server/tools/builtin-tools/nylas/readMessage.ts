import type { BuiltinToolDefinition } from '../../builtinTools';
import { getNylasCredentials, refreshAccessToken, handleTokenError, fetchWithTimeout } from './credentials';
import type { NylasMessage } from './types';

export const readMessageTool: BuiltinToolDefinition = {
  name: 'nylas_read_message',
  description: 'Read the full content of a specific email message including body, headers, and attachment information. If the user references an email they have open, check the context for the message_id before using search/list tools to find it.',
  inputSchema: {
    type: 'object',
    properties: {
      message_id: {
        type: 'string',
        description: 'The ID of the message to read'
      },
      include_headers: {
        type: 'boolean',
        description: 'Include email headers in the response',
        default: false
      }
    },
    required: ['message_id']
  },
  annotations: {
    readOnlyHint: true,
  },
  handler: async (args: Record<string, any>) => {
    try {
      // 1. Check if user has connected their email
      const credentials = await getNylasCredentials();
      if (!credentials) {
        return {
          content: [{
            type: 'text',
            text: 'Error: Email not connected. Please set up Nylas in Settings first.'
          }],
          isError: true
        };
      }

      // 2. Validate required parameters
      if (!args.message_id) {
        return {
          content: [{
            type: 'text',
            text: 'Error: message_id is required'
          }],
          isError: true
        };
      }

      // 3. Check if access token is expired, refresh if needed
      let accessToken = credentials.access_token;
      if (Date.now() / 1000 > credentials.expires_at) {
        accessToken = await refreshAccessToken();
      }

      // 4. Build query parameters
      const fields = args.include_headers ? '?fields=include_headers' : '';

      // 5. Make API request (use /me/ with access token per Nylas docs)
      const response = await fetchWithTimeout(
        `https://api.us.nylas.com/v3/grants/me/messages/${args.message_id}${fields}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json'
          }
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        const cleared = await handleTokenError(errorText);
        if (cleared) {
          return {
            content: [{
              type: 'text',
              text: 'Error: Your email session has expired. Please reconnect your email in Settings.'
            }],
            isError: true
          };
        }
        let errorMessage;
        try {
          const errorJson = JSON.parse(errorText);
          const errDetail = errorJson.message || errorJson.error;
          errorMessage = typeof errDetail === 'object' ? JSON.stringify(errDetail) : errDetail || response.statusText;
        } catch {
          errorMessage = errorText || response.statusText;
        }
        throw new Error(`Nylas API error: ${errorMessage}`);
      }

      const responseData = await response.json() as { data: NylasMessage & { headers?: any } };
      const message = responseData.data;

      // 6. Format message for AI
      const formatted: Record<string, any> = {
        id: message.id,
        thread_id: message.thread_id,
        subject: message.subject,
        from: message.from?.map(f => ({
          email: f.email,
          name: f.name
        })),
        to: message.to?.map(t => ({
          email: t.email,
          name: t.name
        })),
        cc: message.cc?.map(c => ({
          email: c.email,
          name: c.name
        })),
        date: new Date(message.date * 1000).toISOString(),
        body: message.body || message.snippet,
        unread: message.unread,
        starred: message.starred,
        folders: message.folders
      };

      // Include attachments if present
      if (message.attachments && message.attachments.length > 0) {
        formatted.attachments = message.attachments.map(att => ({
          id: att.id,
          filename: att.filename,
          content_type: att.content_type,
          size: att.size,
          size_formatted: formatBytes(att.size)
        }));
      }

      // Include headers if requested
      if (args.include_headers && message.headers) {
        formatted.headers = message.headers;
      }

      // 7. Return formatted result
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(formatted, null, 2)
        }],
        isError: false
      };

    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error reading message: ${error.message}`
        }],
        isError: true
      };
    }
  }
};

// Helper function to format bytes
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}
