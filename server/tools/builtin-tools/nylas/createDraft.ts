import * as fs from 'fs/promises';
import * as path from 'path';
import type { BuiltinToolDefinition } from '../../builtinTools';
import { rejectIfInternalContext } from '../../../utils/contentGuard.js';
import { getNylasCredentials, refreshAccessToken, handleTokenError, fetchWithTimeout } from './credentials';
import { getCurrentWorkspace } from '../../../utils/workspace';
import { resolvePathWithWorkspace } from '../../../utils/permissions';

// Helper to get MIME type from file extension
function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.html': 'text/html',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.zip': 'application/zip',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.ics': 'application/ics',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

export const createDraftTool: BuiltinToolDefinition = {
  name: 'nylas_create_draft',
  description: 'Create an email draft with optional attachments (does NOT send the email). The draft will be saved to the Drafts folder. You can attach files from the workspace.',
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
        description: 'Message ID to reply to (for creating reply drafts). Use this when replying to an email.'
      },
      attachments: {
        type: 'array',
        items: {
          type: 'string'
        },
        description: 'List of file paths to attach (relative to workspace or absolute). Files must be under 3MB each.'
      }
    },
    required: ['to', 'subject', 'body']
  },
  fileAccess: {
    mode: 'read',
    pathArg: 'attachments',
  },
  handler: async (args: Record<string, any>, _context) => {
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

      // 3. Check if access token is expired, refresh if needed
      let accessToken = credentials.access_token;
      if (Date.now() / 1000 > credentials.expires_at) {
        accessToken = await refreshAccessToken();
      }

      // 4. Build draft request body (body is HTML)
      const draftBody: any = {
        to: args.to,
        subject: args.subject,
        body: args.body
      };

      if (args.cc && args.cc.length > 0) {
        draftBody.cc = args.cc;
      }
      if (args.bcc && args.bcc.length > 0) {
        draftBody.bcc = args.bcc;
      }
      if (args.reply_to_message_id) {
        draftBody.reply_to_message_id = args.reply_to_message_id;
      }

      // 5. Process attachments if provided
      if (args.attachments && Array.isArray(args.attachments) && args.attachments.length > 0) {
        const workspace = getCurrentWorkspace();
        if (!workspace) {
          return {
            content: [{ type: 'text', text: 'Error: No workspace set. Cannot resolve attachment paths.' }],
            isError: true
          };
        }

        const attachmentsArray: Array<{ content: string; content_type: string; filename: string }> = [];
        const MAX_ATTACHMENT_SIZE = 3 * 1024 * 1024; // 3MB limit for JSON schema

        for (const attachmentPath of args.attachments) {
          // Resolve path
          const resolvedPath = resolvePathWithWorkspace(attachmentPath, workspace);

          // Read the file
          try {
            const fileBuffer = await fs.readFile(resolvedPath);

            // Check file size
            if (fileBuffer.length > MAX_ATTACHMENT_SIZE) {
              return {
                content: [{
                  type: 'text',
                  text: `Error: Attachment "${path.basename(resolvedPath)}" is too large (${(fileBuffer.length / 1024 / 1024).toFixed(2)}MB). Maximum size is 3MB.`
                }],
                isError: true
              };
            }

            const filename = path.basename(resolvedPath);
            attachmentsArray.push({
              content: fileBuffer.toString('base64'),
              content_type: getMimeType(filename),
              filename: filename
            });
          } catch (readError: any) {
            return {
              content: [{
                type: 'text',
                text: `Error: Failed to read attachment "${attachmentPath}": ${readError.message}`
              }],
              isError: true
            };
          }
        }

        draftBody.attachments = attachmentsArray;
      }

      // 5. Make API request to create draft (use /me/ with access token per Nylas docs)
      const response = await fetchWithTimeout(
        'https://api.us.nylas.com/v3/grants/me/drafts',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify(draftBody)
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
      const draft = data.data;

      // 6. Return success with draft info
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'Draft created successfully (NOT sent)',
            draft: {
              id: draft.id,
              subject: draft.subject,
              to: draft.to,
              cc: draft.cc,
              bcc: draft.bcc,
              created_at: draft.date ? new Date(draft.date * 1000).toISOString() : new Date().toISOString()
            }
          }, null, 2)
        }],
        isError: false
      };

    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error creating draft: ${error.message}`
        }],
        isError: true
      };
    }
  }
};
