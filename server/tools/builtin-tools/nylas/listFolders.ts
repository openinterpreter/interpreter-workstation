import type { BuiltinToolDefinition } from '../../builtinTools';
import { getNylasCredentials, refreshAccessToken, handleTokenError, fetchWithTimeout } from './credentials';

export const listFoldersTool: BuiltinToolDefinition = {
  name: 'nylas_list_folders',
  description: 'List all email folders/labels in the user\'s mailbox (e.g., Inbox, Sent, Drafts, custom folders)',
  inputSchema: {
    type: 'object',
    properties: {
      parent_id: {
        type: 'string',
        description: 'Get only folders that are children of this folder ID'
      },
      include_hidden: {
        type: 'boolean',
        description: 'Include hidden system folders (Microsoft accounts only)',
        default: false
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
      if (args.parent_id) {
        queryParams.append('parent_id', args.parent_id);
      }
      if (args.include_hidden) {
        queryParams.append('include_hidden_folders', 'true');
      }

      // 4. Make API request (use /me/ with access token per Nylas docs)
      const queryString = queryParams.toString();
      const url = `https://api.us.nylas.com/v3/grants/me/folders${queryString ? '?' + queryString : ''}`;

      const response = await fetchWithTimeout(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        }
      });

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
      const folders = data.data;

      // 5. Format folders for AI
      const formatted = folders.map((folder: any) => ({
        id: folder.id,
        name: folder.name,
        system_folder: folder.system_folder,
        unread_count: folder.unread_count,
        total_count: folder.total_count,
        parent_id: folder.parent_id,
        background_color: folder.background_color,
        text_color: folder.text_color
      }));

      // 6. Return formatted results
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            count: formatted.length,
            folders: formatted
          }, null, 2)
        }],
        isError: false
      };

    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error listing folders: ${error.message}`
        }],
        isError: true
      };
    }
  }
};
