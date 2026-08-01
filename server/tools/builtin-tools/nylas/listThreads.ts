import type { BuiltinToolDefinition } from '../../builtinTools';
import { getNylasCredentials, refreshAccessToken, handleTokenError, fetchWithTimeout } from './credentials';

export const listThreadsTool: BuiltinToolDefinition = {
  name: 'nylas_list_threads',
  description: 'List email threads (conversations) from the user\'s mailbox. Threads group related messages together (replies, forwards in the same conversation).',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Number of threads to retrieve (default 10, max 50)',
        default: 10
      },
      page_token: {
        type: 'string',
        description: 'Token for fetching the next page of results (from previous response\'s next_cursor)'
      },
      folder: {
        type: 'string',
        description: 'Folder ID to filter threads (e.g., "INBOX", "SENT")'
      },
      unread: {
        type: 'boolean',
        description: 'Filter for threads with unread messages'
      },
      starred: {
        type: 'boolean',
        description: 'Filter for starred threads'
      },
      subject: {
        type: 'string',
        description: 'Filter by subject (partial match)'
      },
      any_email: {
        type: 'string',
        description: 'Filter by participant email address'
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
      if (args.unread !== undefined) {
        queryParams.append('unread', args.unread.toString());
      }
      if (args.starred !== undefined) {
        queryParams.append('starred', args.starred.toString());
      }
      if (args.subject) {
        queryParams.append('subject', args.subject);
      }
      if (args.any_email) {
        queryParams.append('any_email', args.any_email);
      }

      // 4. Make API request to threads endpoint
      const response = await fetchWithTimeout(
        `https://api.us.nylas.com/v3/grants/me/threads?${queryParams.toString()}`,
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

      const data = await response.json() as { data: any[], next_cursor?: string };
      const threads = data.data;

      // 5. Format threads for AI
      const formatted = threads.map((thread: any) => ({
        id: thread.id,
        subject: thread.subject,
        snippet: thread.snippet,
        participants: thread.participants?.map((p: any) => p.email),
        message_count: thread.message_ids?.length || 0,
        has_drafts: thread.has_drafts,
        has_attachments: thread.has_attachments,
        unread: thread.unread,
        starred: thread.starred,
        folders: thread.folders,
        latest_message_date: thread.latest_message_received_date
          ? new Date(thread.latest_message_received_date * 1000).toISOString()
          : null,
        earliest_message_date: thread.earliest_message_date
          ? new Date(thread.earliest_message_date * 1000).toISOString()
          : null
      }));

      // 6. Return formatted results with pagination info
      const result: any = {
        count: formatted.length,
        threads: formatted
      };

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
          text: `Error listing threads: ${error.message}`
        }],
        isError: true
      };
    }
  }
};
