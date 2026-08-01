import type { BuiltinToolDefinition } from '../../builtinTools';
import { getNylasCredentials, refreshAccessToken, handleTokenError, fetchWithTimeout } from './credentials';

export const listDraftsTool: BuiltinToolDefinition = {
  name: 'nylas_list_drafts',
  description: 'List email drafts from the user\'s mailbox. Drafts are separate from regular messages in Nylas.',
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Number of drafts to retrieve (default 10, max 50)',
        default: 10
      },
      page_token: {
        type: 'string',
        description: 'Token for fetching the next page of results (from previous response\'s next_cursor)'
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

      // 4. Make API request to drafts endpoint
      const response = await fetchWithTimeout(
        `https://api.us.nylas.com/v3/grants/me/drafts?${queryParams.toString()}`,
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
      const drafts = data.data;

      // 5. Format drafts for AI
      const formatted = drafts.map((draft: any) => ({
        id: draft.id,
        subject: draft.subject,
        to: draft.to?.map((t: any) => t.email),
        cc: draft.cc?.map((c: any) => c.email),
        date: new Date(draft.date * 1000).toISOString(),
        snippet: draft.snippet,
        has_attachments: draft.attachments && draft.attachments.length > 0
      }));

      // 6. Return formatted results with pagination info
      const result: any = {
        count: formatted.length,
        drafts: formatted
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
          text: `Error listing drafts: ${error.message}`
        }],
        isError: true
      };
    }
  }
};
