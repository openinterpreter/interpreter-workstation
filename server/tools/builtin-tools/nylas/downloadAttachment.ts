import * as fs from 'fs/promises';
import * as path from 'path';
import type { BuiltinToolDefinition } from '../../builtinTools';
import { getNylasCredentials, refreshAccessToken, handleTokenError, fetchWithTimeout } from './credentials';
import { getCurrentWorkspace } from '../../../utils/workspace';
import { resolvePathWithWorkspace } from '../../../utils/permissions';

export const downloadAttachmentTool: BuiltinToolDefinition = {
  name: 'nylas_download_attachment',
  description: 'Download an email attachment to a file. You must provide the message_id and attachment_id (use nylas_read_message to get attachment IDs first).',
  inputSchema: {
    type: 'object',
    properties: {
      message_id: {
        type: 'string',
        description: 'The message ID containing the attachment'
      },
      attachment_id: {
        type: 'string',
        description: 'The attachment ID to download (get this from nylas_read_message)'
      },
      output_path: {
        type: 'string',
        description: 'Where to save the file (absolute path or relative to workspace)'
      }
    },
    required: ['message_id', 'attachment_id', 'output_path']
  },
  fileAccess: {
    mode: 'write',
    pathArg: 'output_path'
  },
  handler: async (args: Record<string, any>) => {
    console.log('[nylas_download_attachment] Handler called with args:', JSON.stringify(args, null, 2));
    try {
      // 1. Check if user has connected their email
      const credentials = await getNylasCredentials();
      console.log('[nylas_download_attachment] Credentials loaded, grant_id:', credentials?.grant_id);
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
      if (!args.attachment_id) {
        return {
          content: [{
            type: 'text',
            text: 'Error: attachment_id is required'
          }],
          isError: true
        };
      }
      if (!args.output_path) {
        return {
          content: [{
            type: 'text',
            text: 'Error: output_path is required'
          }],
          isError: true
        };
      }

      // 3. Check if access token is expired, refresh if needed
      let accessToken = credentials.access_token;
      if (Date.now() / 1000 > credentials.expires_at) {
        accessToken = await refreshAccessToken();
      }

      // 4. First, get attachment metadata to get filename (use /me/ with access token per Nylas docs)
      const metadataResponse = await fetchWithTimeout(
        `https://api.us.nylas.com/v3/grants/me/messages/${args.message_id}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/json'
          }
        }
      );

      if (!metadataResponse.ok) {
        const errorText = await metadataResponse.text();
        console.log('[nylas_download_attachment] Metadata fetch failed:', metadataResponse.status, errorText);
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
          // Handle nested error objects
          const errDetail = errorJson.message || errorJson.error;
          errorMessage = typeof errDetail === 'object' ? JSON.stringify(errDetail) : errDetail || metadataResponse.statusText;
        } catch {
          errorMessage = errorText || metadataResponse.statusText;
        }
        throw new Error(`Failed to get message metadata (${metadataResponse.status}): ${errorMessage}`);
      }

      const responseData = await metadataResponse.json() as { data: { attachments?: Array<{ id: string; filename?: string; content_type?: string }> } };
      const messageData = responseData.data;
      const attachment = messageData.attachments?.find((att) => att.id === args.attachment_id);

      if (!attachment) {
        throw new Error(`Attachment ${args.attachment_id} not found in message ${args.message_id}`);
      }

      // 5. Resolve output path first (handle relative paths relative to workspace)
      const workspace = getCurrentWorkspace();
      if (!workspace) {
        return {
          content: [{ type: 'text', text: 'Error: No workspace set. Cannot resolve output path.' }],
          isError: true
        };
      }
      const outputPath = resolvePathWithWorkspace(args.output_path, workspace);

      // 6. Ensure directory exists
      const dir = path.dirname(outputPath);
      await fs.mkdir(dir, { recursive: true });

      // 7. Download the attachment
      // Nylas v3 API: GET /v3/grants/me/attachments/{attachment_id}/download?message_id={message_id}
      // Use /me/ with access token per Nylas docs, message_id is a QUERY PARAM
      const encodedAttachmentId = encodeURIComponent(args.attachment_id);
      const downloadUrl = `https://api.us.nylas.com/v3/grants/me/attachments/${encodedAttachmentId}/download?message_id=${args.message_id}`;
      console.log('[nylas_download_attachment] Downloading from:', downloadUrl);

      // Track download progress
      let bytesDownloaded = 0;
      const downloadStartTime = Date.now();

      // Start the download with progress tracking
      const downloadPromise = (async () => {
        const downloadResponse = await fetch(downloadUrl, {
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        });

        if (!downloadResponse.ok) {
          const errorText = await downloadResponse.text();
          console.log('[nylas_download_attachment] Download failed:', downloadResponse.status, errorText);
          await handleTokenError(errorText);
          throw new Error(`Failed to download attachment (${downloadResponse.status}): ${errorText}`);
        }

        // Stream the response to track progress
        const reader = downloadResponse.body?.getReader();
        if (!reader) {
          throw new Error('No response body reader available');
        }

        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          bytesDownloaded += value.length;
        }

        // Combine chunks into buffer
        const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }

        const buffer = Buffer.from(combined);
        await fs.writeFile(outputPath, buffer);
        console.log('[nylas_download_attachment] Successfully saved:', outputPath, formatBytes(buffer.length));
        return buffer;
      })();

      // Wait up to 30 seconds for the download to complete
      const QUICK_TIMEOUT = 30000;
      let buffer: Buffer | null = null;

      try {
        buffer = await Promise.race([
          downloadPromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('TIMEOUT')), QUICK_TIMEOUT)
          )
        ]);
      } catch (err: any) {
        if (err.message === 'TIMEOUT') {
          // Download is still in progress - let it continue in background
          const elapsedSeconds = (Date.now() - downloadStartTime) / 1000;
          const speedBytesPerSec = bytesDownloaded / elapsedSeconds;
          const totalSize = (attachment as any).size || 0;
          const remainingBytes = totalSize - bytesDownloaded;
          const estimatedSecondsRemaining = speedBytesPerSec > 0 ? Math.ceil(remainingBytes / speedBytesPerSec) : null;

          console.log('[nylas_download_attachment] Download taking longer than 30s, continuing in background');
          console.log(`[nylas_download_attachment] Progress: ${formatBytes(bytesDownloaded)} / ${formatBytes(totalSize)} at ${formatBytes(speedBytesPerSec)}/s`);

          // Handle the background promise to log completion/errors
          downloadPromise
            .then(() => console.log('[nylas_download_attachment] Background download completed:', outputPath))
            .catch(e => console.error('[nylas_download_attachment] Background download failed:', e.message));

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'downloading_in_background',
                message: 'Download is still in progress and will complete in the background.',
                filename: attachment.filename,
                progress: {
                  bytes_downloaded: bytesDownloaded,
                  bytes_downloaded_formatted: formatBytes(bytesDownloaded),
                  total_size: totalSize,
                  total_size_formatted: formatBytes(totalSize),
                  percent_complete: totalSize > 0 ? Math.round((bytesDownloaded / totalSize) * 100) : null,
                  speed_bytes_per_sec: Math.round(speedBytesPerSec),
                  speed_formatted: `${formatBytes(speedBytesPerSec)}/s`,
                  estimated_seconds_remaining: estimatedSecondsRemaining
                },
                content_type: attachment.content_type,
                output_path: outputPath
              }, null, 2)
            }],
            isError: false
          };
        }
        throw err;
      }

      // 8. Return success message
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: 'Attachment downloaded successfully',
            filename: attachment.filename,
            size: buffer.length,
            size_formatted: formatBytes(buffer.length),
            content_type: attachment.content_type,
            output_path: outputPath
          }, null, 2)
        }],
        isError: false
      };

    } catch (error: any) {
      return {
        content: [{
          type: 'text',
          text: `Error downloading attachment: ${error.message}`
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
