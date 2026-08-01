import type { BuiltinToolDefinition, BuiltinToolContext } from '../../builtinTools';
import { rejectIfInternalContext } from '../../../utils/contentGuard.js';
import { getNylasCredentials, refreshAccessToken, handleTokenError, fetchWithTimeout } from './credentials';
import { approvalManager } from '../../../approvalManager';

export const sendEmailTool: BuiltinToolDefinition = {
  name: 'nylas_send_email',
  description: 'Send an email. The user will be prompted to approve before the email is sent.',
  inputSchema: {
    type: 'object',
    properties: {
      to: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            email: { type: 'string', description: 'Recipient email address' },
            name: { type: 'string', description: 'Recipient display name (optional)' }
          },
          required: ['email']
        },
        description: 'List of recipients (required)'
      },
      subject: {
        type: 'string',
        description: 'Email subject line'
      },
      body: {
        type: 'string',
        description: 'Email body content (HTML). Use <br> for line breaks, <a href="..."> for links, etc.'
      },
      cc: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            email: { type: 'string' },
            name: { type: 'string' }
          },
          required: ['email']
        },
        description: 'CC recipients (optional)'
      },
      bcc: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            email: { type: 'string' },
            name: { type: 'string' }
          },
          required: ['email']
        },
        description: 'BCC recipients (optional)'
      },
      reply_to_message_id: {
        type: 'string',
        description: 'Message ID to reply to (for sending replies)'
      }
    },
    required: ['to', 'subject', 'body']
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
      if (!args.to || !Array.isArray(args.to) || args.to.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'Error: At least one recipient (to) is required'
          }],
          isError: true
        };
      }
      if (!args.subject) {
        return {
          content: [{
            type: 'text',
            text: 'Error: Subject is required'
          }],
          isError: true
        };
      }
      if (!args.body) {
        return {
          content: [{
            type: 'text',
            text: 'Error: Body is required'
          }],
          isError: true
        };
      }

      const contextRejection = rejectIfInternalContext(args.body as string);
      if (contextRejection) return contextRejection;

      // 3. Request user approval before sending
      const toolCallId = context?.toolCallId;
      const approvalDetails = {
        to: args.to.map((r: any) => r.name ? `${r.name} <${r.email}>` : r.email).join(', '),
        subject: args.subject,
        cc: args.cc?.map((r: any) => r.email).join(', ') || null,
        bodyPreview: args.body.substring(0, 200) + (args.body.length > 200 ? '...' : '')
      };

      const approved = await approvalManager.createApproval(
        'nylas_send_email',
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
              message: 'Email sending was denied by user',
              timestamp: new Date().toISOString()
            }, null, 2)
          }],
          isError: false
        };
      }

      // 4. User approved - proceed with sending
      let accessToken = credentials.access_token;
      if (Date.now() / 1000 > credentials.expires_at) {
        accessToken = await refreshAccessToken();
      }

      // 5. Build send request body
      const sendBody: any = {
        to: args.to,
        subject: args.subject,
        body: args.body
      };

      if (args.cc && args.cc.length > 0) {
        sendBody.cc = args.cc;
      }
      if (args.bcc && args.bcc.length > 0) {
        sendBody.bcc = args.bcc;
      }
      if (args.reply_to_message_id) {
        sendBody.reply_to_message_id = args.reply_to_message_id;
      }

      // 6. Make API request to send email
      const response = await fetchWithTimeout(
        'https://api.us.nylas.com/v3/grants/me/messages/send',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify(sendBody)
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

      const data = await response.json() as { data: any };
      const sentMessage = data.data;

      // 7. Return success
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            sent: true,
            message: 'Email sent successfully',
            email: {
              id: sentMessage.id,
              subject: sentMessage.subject,
              to: sentMessage.to,
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
          text: `Error sending email: ${error.message}`
        }],
        isError: true
      };
    }
  }
};
