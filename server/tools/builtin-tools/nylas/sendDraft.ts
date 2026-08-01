import type { BuiltinToolDefinition, BuiltinToolContext } from '../../builtinTools';
import { getNylasCredentials, refreshAccessToken, handleTokenError, fetchWithTimeout } from './credentials';
import { approvalManager } from '../../../approvalManager';

export const sendDraftTool: BuiltinToolDefinition = {
  name: 'nylas_send_draft',
  description: 'Send an existing draft email. The user will be prompted to approve before the draft is sent. Use nylas_list_drafts to get draft IDs.',
  inputSchema: {
    type: 'object',
    properties: {
      draft_id: {
        type: 'string',
        description: 'The ID of the draft to send (get this from nylas_list_drafts or nylas_create_draft)'
      }
    },
    required: ['draft_id']
  },
  handler: async (args: Record<string, any>, context?: BuiltinToolContext) => {
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
      if (!args.draft_id) {
        return {
          content: [{
            type: 'text',
            text: 'Error: draft_id is required'
          }],
          isError: true
        };
      }

      // 3. Check if access token is expired, refresh if needed
      let accessToken = credentials.access_token;
      if (Date.now() / 1000 > credentials.expires_at) {
        accessToken = await refreshAccessToken();
      }

      // 4. First, fetch the draft to show details for approval
      const draftResponse = await fetchWithTimeout(
        `https://api.us.nylas.com/v3/grants/me/drafts/${args.draft_id}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json'
          }
        }
      );

      if (!draftResponse.ok) {
        const errorText = await draftResponse.text();
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
          errorMessage = typeof errDetail === 'object' ? JSON.stringify(errDetail) : errDetail || draftResponse.statusText;
        } catch {
          errorMessage = errorText || draftResponse.statusText;
        }
        throw new Error(`Failed to fetch draft: ${errorMessage}`);
      }

      const draftData = await draftResponse.json() as { data: any };
      const draft = draftData.data;

      // 5. Request user approval before sending
      const toolCallId = context?.toolCallId;
      const approvalDetails = {
        draft_id: args.draft_id,
        to: draft.to?.map((r: any) => r.name ? `${r.name} <${r.email}>` : r.email).join(', ') || '(no recipients)',
        subject: draft.subject || '(no subject)',
        cc: draft.cc?.map((r: any) => r.email).join(', ') || null,
        bodyPreview: (draft.body || draft.snippet || '').substring(0, 200) + ((draft.body || draft.snippet || '').length > 200 ? '...' : '')
      };

      const approved = await approvalManager.createApproval(
        'nylas_send_draft',
        'builtin-nylas',
        approvalDetails,
        60000, // 60 second timeout for approval
        toolCallId,
        context?.agentId
      );

      if (!approved) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              sent: false,
              message: 'Draft sending was denied by user',
              draft_id: args.draft_id,
              timestamp: new Date().toISOString()
            }, null, 2)
          }],
          isError: false
        };
      }

      // 6. User approved - proceed with sending the draft
      // Nylas v3 API: POST /v3/grants/me/drafts/{draft_id} to send
      const sendResponse = await fetchWithTimeout(
        `https://api.us.nylas.com/v3/grants/me/drafts/${args.draft_id}`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json'
          }
        }
      );

      if (!sendResponse.ok) {
        const errorText = await sendResponse.text();
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
          errorMessage = typeof errDetail === 'object' ? JSON.stringify(errDetail) : errDetail || sendResponse.statusText;
        } catch {
          errorMessage = errorText || sendResponse.statusText;
        }
        throw new Error(`Failed to send draft: ${errorMessage}`);
      }

      const sentData = await sendResponse.json() as { data: any };
      const sentMessage = sentData.data;

      // 7. Return success
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            sent: true,
            message: 'Draft sent successfully',
            email: {
              id: sentMessage.id,
              subject: sentMessage.subject || draft.subject,
              to: sentMessage.to || draft.to,
              sent_at: new Date().toISOString()
            }
          }, null, 2)
        }],
        isError: false
      };

    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error sending draft: ${error.message}`
        }],
        isError: true
      };
    }
  }
};
