import type { BuiltinToolDefinition } from '../../builtinTools';
import { getNylasCredentials, refreshAccessToken, handleTokenError, fetchWithTimeout } from './credentials';

export const listMessagesTool: BuiltinToolDefinition = {
  name: 'nylas_list_messages',
  description: 'List email messages from the user\'s mailbox with pagination and folder filtering. Note: If the user has provided a message ID in context, use nylas_read_message directly.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Number of messages to retrieve (default 10, max 50)',
        default: 10
      },
      page_token: {
        type: 'string',
        description: 'Token for fetching the next page of results (from previous response\'s next_cursor)'
      },
      folder: {
        type: 'string',
        description: 'Folder ID to filter messages (e.g., "INBOX", "SENT", "DRAFTS", or a custom folder ID)'
      },
      unread_only: {
        type: 'boolean',
        description: 'Only return unread messages',
        default: false
      },
      starred: {
        type: 'boolean',
        description: 'Only return starred/flagged messages'
      }
    }
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

      // 2. Check if access token is expired, refresh if needed
      let accessToken = credentials.access_token;
      if (Date.now() / 1000 > credentials.expires_at) {
        accessToken = await refreshAccessToken();
      }

      // 3. Build query parameters
      const queryParams = new URLSearchParams();
      const limit = Math.min(args.limit || 10, 50);
      queryParams.append('limit', limit.toString());

      if (args.page_token) {
        queryParams.append('page_token', args.page_token);
      }
      if (args.folder) {
        queryParams.append('in', args.folder);
      }
      if (args.unread_only) {
        queryParams.append('unread', 'true');
      }
      if (args.starred !== undefined) {
        queryParams.append('starred', args.starred.toString());
      }

      // 4. Make API request (use /me/ with access token per Nylas docs)
      const response = await fetchWithTimeout(
        `https://api.us.nylas.com/v3/grants/me/messages?${queryParams.toString()}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json'
          }
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        // Check if token is invalid and clear credentials if so
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

      const data = await response.json() as { data: any[], next_cursor?: string };
      const messages = data.data;

      // 5. Format messages for AI
      const formatted = messages.map((msg: any) => ({
        id: msg.id,
        subject: msg.subject,
        from: msg.from?.[0]?.email,
        from_name: msg.from?.[0]?.name,
        date: new Date(msg.date * 1000).toISOString(),
        snippet: msg.snippet,
        unread: msg.unread,
        starred: msg.starred,
        folders: msg.folders,
        has_attachments: msg.attachments && msg.attachments.length > 0
      }));

      // 6. Return formatted results with pagination info
      const result: any = {
        count: formatted.length,
        messages: formatted
      };

      // Include next page token if available
      if (data.next_cursor) {
        result.next_cursor = data.next_cursor;
        result.has_more = true;
      } else {
        result.has_more = false;
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }],
        isError: false
      };

    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error listing messages: ${error.message}`
        }],
        isError: true
      };
    }
  }
};
