import type { BuiltinToolDefinition } from '../../builtinTools';
import { getNylasCredentials, refreshAccessToken, handleTokenError, fetchWithTimeout } from './credentials';

export const searchMessagesTool: BuiltinToolDefinition = {
  name: 'nylas_search_messages',
  description: 'Search for email messages using various criteria including subject, sender, recipient, date range, and attachment status',
  inputSchema: {
    type: 'object',
    properties: {
      search_query_native: {
        type: 'string',
        description: 'Native provider search query (e.g., Gmail syntax: "from:user@example.com subject:hello has:attachment after:2024/01/01"). Most powerful search option.'
      },
      subject: {
        type: 'string',
        description: 'Search in subject line (case-insensitive partial match)'
      },
      from: {
        type: 'string',
        description: 'Filter by sender - MUST be a full valid email address (e.g., "user@example.com", NOT just "example.com")'
      },
      to: {
        type: 'string',
        description: 'Filter by recipient - MUST be a full valid email address'
      },
      any_email: {
        type: 'string',
        description: 'Match any email in To, From, CC, or BCC fields - MUST be a full valid email address'
      },
      received_after: {
        type: 'string',
        description: 'Filter messages received after this date (ISO 8601 format or Unix timestamp)'
      },
      received_before: {
        type: 'string',
        description: 'Filter messages received before this date (ISO 8601 format or Unix timestamp)'
      },
      has_attachment: {
        type: 'boolean',
        description: 'Filter for messages with attachments'
      },
      unread: {
        type: 'boolean',
        description: 'Filter for unread messages'
      },
      starred: {
        type: 'boolean',
        description: 'Filter for starred/flagged messages'
      },
      in_folder: {
        type: 'string',
        description: 'Filter by folder ID (e.g., "INBOX", "SENT")'
      },
      limit: {
        type: 'number',
        description: 'Maximum number of messages to retrieve (default 20, max 50)',
        default: 20
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
      const limit = Math.min(args.limit || 20, 50);
      queryParams.append('limit', limit.toString());

      // Native search query - most powerful, uses provider's syntax (e.g., Gmail search)
      if (args.search_query_native) {
        queryParams.append('search_query_native', args.search_query_native);
      }

      if (args.subject) queryParams.append('subject', args.subject);
      if (args.from) queryParams.append('from', args.from);
      if (args.to) queryParams.append('to', args.to);
      if (args.any_email) queryParams.append('any_email', args.any_email);

      // Handle date parameters (convert ISO strings to Unix timestamps if needed)
      if (args.received_after) {
        const timestamp = typeof args.received_after === 'number'
          ? args.received_after
          : Math.floor(new Date(args.received_after).getTime() / 1000);
        queryParams.append('received_after', timestamp.toString());
      }
      if (args.received_before) {
        const timestamp = typeof args.received_before === 'number'
          ? args.received_before
          : Math.floor(new Date(args.received_before).getTime() / 1000);
        queryParams.append('received_before', timestamp.toString());
      }

      if (args.has_attachment !== undefined) queryParams.append('has_attachment', args.has_attachment.toString());
      if (args.unread !== undefined) queryParams.append('unread', args.unread.toString());
      if (args.starred !== undefined) queryParams.append('starred', args.starred.toString());
      if (args.in_folder) queryParams.append('in', args.in_folder);

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

      const data = await response.json() as { data: any[] };
      const messages = data.data;

      // 5. Format messages for AI
      const formatted = messages.map((msg: any) => ({
        id: msg.id,
        subject: msg.subject,
        from: msg.from?.[0]?.email,
        from_name: msg.from?.[0]?.name,
        to: msg.to?.map((t: any) => t.email),
        date: new Date(msg.date * 1000).toISOString(),
        snippet: msg.snippet,
        unread: msg.unread,
        starred: msg.starred,
        has_attachment: msg.attachments && msg.attachments.length > 0
      }));

      // 6. Return formatted results
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            count: formatted.length,
            messages: formatted
          }, null, 2)
        }],
        isError: false
      };

    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error searching messages: ${error.message}`
        }],
        isError: true
      };
    }
  }
};
