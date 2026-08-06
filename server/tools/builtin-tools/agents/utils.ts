// Utilities for creating subagent tools

import type { BuiltinToolContext } from '../../builtinTools';
import { getMaxSubagentDepthSync, getDefaultProfile, getFastProfile } from '../../../configStore';
import type { AgentModelConfig } from '../../../../shared/types/model';
import { profileToModelConfig } from '../../../../shared/types/profile';

/**
 * Default maximum subagent nesting depth
 */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 5;

/**
 * Check if spawning a new subagent would exceed the depth limit
 * Uses context.maxDepth if provided, otherwise reads from global config
 * @returns Object with allowed boolean and optional error message
 */
export function checkDepthLimit(context?: BuiltinToolContext): { allowed: boolean; error?: string } {
  const currentDepth = (context?.toolCallPath?.length ?? 0) + 1;
  // Use context maxDepth (from profile) if provided, otherwise use global config setting
  const maxDepth = context?.maxDepth ?? getMaxSubagentDepthSync();

  console.log('[Subagent Depth] Checking depth limit:', {
    toolCallPath: context?.toolCallPath,
    currentDepth,
    maxDepth,
    allowed: currentDepth <= maxDepth,
  });

  if (currentDepth > maxDepth) {
    const pathDisplay = context?.toolCallPath?.length
      ? context.toolCallPath.map(p => p.split('-')[0]).join(' → ')
      : 'root';
    console.error('[Subagent Depth] BLOCKED: Maximum depth exceeded!', { currentDepth, maxDepth, path: pathDisplay });
    return {
      allowed: false,
      error: `Maximum subagent nesting depth (${maxDepth}) exceeded. Current path: ${pathDisplay}. Consider using fewer nested agents or increasing the depth limit in settings.`
    };
  }
  return { allowed: true };
}

/**
 * Build the tool call path for a new subagent
 * @param context Parent context (may include existing path)
 * @param toolName Name of the subagent tool
 * @param toolCallId The tool call ID for this invocation
 * @returns Full path array for the new subagent
 */
export function buildToolCallPath(
  context: BuiltinToolContext | undefined,
  toolName: string,
  toolCallId: string
): string[] {
  const parentPath = context?.toolCallPath || [];
  return [...parentPath, `${toolName}-${toolCallId}`];
}

/**
 * Resolve runtime context for subagent tools.
 * Uses parent context when available, otherwise falls back to selected profile/settings.
 */
export interface ResolveSubagentExecutionContextOptions {
  preferFastProfile?: boolean;
}

export async function resolveSubagentExecutionContext(
  context: BuiltinToolContext | undefined,
  options?: ResolveSubagentExecutionContextOptions
): Promise<{ modelConfig: AgentModelConfig; agentId: string }> {
  const preferFastProfile = options?.preferFastProfile === true;
  const fastProfile = preferFastProfile ? await getFastProfile() : null;
  let modelConfig: AgentModelConfig | undefined = fastProfile ? profileToModelConfig(fastProfile) : undefined;

  if (!modelConfig) {
    modelConfig = context?.modelConfig;
  }

  if (!modelConfig) {
    const selectedProfile = await getDefaultProfile();
    if (!selectedProfile) {
      throw new Error('No model configuration available: select a model profile in Settings.');
    }
    modelConfig = profileToModelConfig(selectedProfile);
  }

  const agentId = context?.agentId || context?.callerTabId || (context?.messageId ? `subagent-${context.messageId}` : 'subagent-global');

  return { modelConfig, agentId };
}

/**
 * Maximum number of retries when a subagent doesn't produce a final text response
 */
export const SUBAGENT_NO_RESPONSE_RETRIES = 2;

/**
 * Result of running a subagent with retry logic
 */
export type SubagentResult = {
  success: true;
  responseText: string;
  logPath: string;
  hitMaxSteps: boolean;
  messages: any[];
} | {
  success: false;
  error: string;
  logPath?: string;
  isError: true;
}

/**
 * Options for running a subagent with retry
 */
export interface RunSubagentOptions {
  agentName: string;
  runAgentFn: () => Promise<any>; // Returns AgentRunResult
  fs: any;
  path: any;
}

function isRetryableSubagentError(error?: string): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  return (
    normalized.includes('timeout')
    || normalized.includes('timed out')
    || normalized.includes('network')
    || normalized.includes('stream disconnected')
    || normalized.includes('response body')
    || normalized.includes('aborted')
    || normalized.includes('terminated')
  );
}

/**
 * Run a subagent with automatic retry on no text response
 * Extracts the final text from the assistant's response
 */
export async function runSubagentWithRetry(options: RunSubagentOptions): Promise<SubagentResult> {
  const { agentName, runAgentFn, fs, path } = options;

  let lastLogPath: string | undefined;

  // Start subagent boundary in agent log
  const agentLog = (global as any).__agentLogging;
  if (agentLog?.startSubagent) {
    agentLog.startSubagent(agentName, '');
  }

  try {
    for (let attempt = 0; attempt <= SUBAGENT_NO_RESPONSE_RETRIES; attempt++) {
      if (attempt > 0) {
        console.log(`[${agentName}] Retry attempt ${attempt}/${SUBAGENT_NO_RESPONSE_RETRIES} - subagent did not produce text response`);
      }

      const result = await runAgentFn();

      if (!result.completed) {
        if (attempt < SUBAGENT_NO_RESPONSE_RETRIES && isRetryableSubagentError(result.error)) {
          console.warn(`[${agentName}] Attempt ${attempt + 1}: transient subagent failure, retrying: ${result.error}`);
          continue;
        }
        return {
          success: false,
          error: result.error || 'Agent did not complete',
          isError: true
        };
      }

      // Log conversation history
      const logPath = await logConversationHistory(agentName, result.messages, fs, path);
      lastLogPath = logPath;

      // Extract final text from assistant messages
      const assistantMessages = result.messages.filter((m: any) => m.role === 'assistant');
      const finalMessage = assistantMessages[assistantMessages.length - 1];
      const textParts = (finalMessage?.parts?.filter((p: any) => p.type === 'text') || []) as Array<{ type: 'text'; text: string }>;
      const lastTextPart = textParts[textParts.length - 1];
      const responseText = lastTextPart?.text?.trim();

      // Retry if no text response
      if (!responseText) {
        console.error(`[${agentName}] Attempt ${attempt + 1}: Subagent did not produce a final text response`);
        console.error(`[${agentName}] Assistant messages count:`, assistantMessages.length);
        console.error(`[${agentName}] Final message parts:`, JSON.stringify(finalMessage?.parts, null, 2));

        if (attempt < SUBAGENT_NO_RESPONSE_RETRIES) {
          continue; // Retry
        }

        // All retries exhausted
        console.error(`[${agentName}] All retries exhausted - no text response produced`);
        return {
          success: false,
          error: `Subagent did not produce a final text response after ${SUBAGENT_NO_RESPONSE_RETRIES + 1} attempts`,
          logPath,
          isError: true
        };
      }

      // Success
      return {
        success: true,
        responseText,
        logPath,
        hitMaxSteps: result.hitMaxSteps,
        messages: result.messages,
      };
    }

    // Should never reach here
    return {
      success: false,
      error: 'Unexpected state after retries',
      logPath: lastLogPath,
      isError: true
    };
  } finally {
    // End subagent boundary in agent log
    if (agentLog?.endSubagent) {
      agentLog.endSubagent();
    }
  }
}

/**
 * Generate diff feedback for multiple files
 */
export async function generateMultiFileDiffFeedback(
  filePaths: string[],
  beforeContents: Map<string, { content: string; raw?: string } | null>,
  fs: any,
  path: any
): Promise<string[]> {
  const feedbacks: string[] = [];

  for (const filePath of filePaths) {
    const beforeContent = beforeContents.get(filePath) ?? null;
    const afterContent = await captureFileContent(filePath, fs);
    const feedback = generateEditFeedback(filePath, beforeContent, afterContent);

    // Only include non-trivial feedback
    if (feedback && !feedback.includes('Could not capture')) {
      feedbacks.push(`**${path.basename(filePath)}:**\n${feedback}`);
    }
  }

  return feedbacks;
}

/**
 * Check if a list of paths contains PDF files
 */
export function hasPdfFiles(paths: string[]): boolean {
  return paths.some(p => p.toLowerCase().endsWith('.pdf'));
}

/**
 * Check if a list of paths contains Word documents
 */
export function hasWordFiles(paths: string[]): boolean {
  return paths.some(p => p.toLowerCase().endsWith('.docx'));
}

/**
 * Check if a list of paths contains images
 */
export function hasImageFiles(paths: string[]): boolean {
  const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
  return paths.some(p => {
    const ext = p.toLowerCase().split('.').pop();
    return ext && imageExts.includes(`.${ext}`);
  });
}

/**
 * Check if a list of paths contains Excel spreadsheets
 */
export function hasExcelFiles(paths: string[]): boolean {
  const excelExts = ['.xlsx', '.xls', '.xlsm', '.xlsb'];
  return paths.some(p => {
    const ext = p.toLowerCase().split('.').pop();
    return ext && excelExts.includes(`.${ext}`);
  });
}

/**
 * File type support configuration
 * Defines what file types are supported for different operations
 */
export const FILE_TYPE_SUPPORT = {
  // Text files that can be read and edited with standard tools
  text: [
    '.txt', '.md', '.js', '.ts', '.jsx', '.tsx', '.json', '.yaml', '.yml',
    '.css', '.scss', '.html', '.xml', '.svg', '.sh', '.bash', '.py', '.rb',
    '.java', '.c', '.cpp', '.h', '.hpp', '.go', '.rs', '.php', '.sql',
    '.env', '.gitignore', '.dockerignore', '.conf', '.ini', '.toml'
  ],
  // PDF files - can be read and have forms edited
  pdf: ['.pdf'],
  // Word documents - can be read and edited
  word: ['.docx'],
  // Excel spreadsheets - can be read and edited
  excel: ['.xlsx', '.xls', '.xlsm', '.xlsb'],
  // Images - read-only
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif']
} as const;

/**
 * Get all supported file extensions for a given operation
 */
export function getSupportedExtensions(operation: 'read' | 'edit'): string[] {
  if (operation === 'read') {
    return [
      ...FILE_TYPE_SUPPORT.text,
      ...FILE_TYPE_SUPPORT.pdf,
      ...FILE_TYPE_SUPPORT.word,
      ...FILE_TYPE_SUPPORT.excel,
      ...FILE_TYPE_SUPPORT.image
    ];
  } else {
    // edit - excludes images
    return [
      ...FILE_TYPE_SUPPORT.text,
      ...FILE_TYPE_SUPPORT.pdf,
      ...FILE_TYPE_SUPPORT.word,
      ...FILE_TYPE_SUPPORT.excel
    ];
  }
}

/**
 * Check what category a file belongs to
 */
export function getFileCategory(filePath: string): 'text' | 'pdf' | 'word' | 'excel' | 'image' | 'unsupported' {
  const ext = '.' + (filePath.toLowerCase().split('.').pop() || '');

  if (FILE_TYPE_SUPPORT.text.includes(ext as any)) return 'text';
  if (FILE_TYPE_SUPPORT.pdf.includes(ext as any)) return 'pdf';
  if (FILE_TYPE_SUPPORT.word.includes(ext as any)) return 'word';
  if (FILE_TYPE_SUPPORT.excel.includes(ext as any)) return 'excel';
  if (FILE_TYPE_SUPPORT.image.includes(ext as any)) return 'image';

  return 'unsupported';
}

/**
 * Check if a file is supported for reading
 */
export function isSupportedReadFile(filePath: string): boolean {
  return getFileCategory(filePath) !== 'unsupported';
}

/**
 * Check if a file is supported for editing
 * (All supported file types except images can be edited)
 */
export function isSupportedEditFile(filePath: string): boolean {
  const category = getFileCategory(filePath);
  return category !== 'unsupported' && category !== 'image';
}

/**
 * Get supported file types message derived from actual tool support
 */
export function getSupportedFileTypesMessage(forEditing: boolean = false): string {
  const extensions = getSupportedExtensions(forEditing ? 'edit' : 'read');

  // Group extensions by category for better readability
  const categories = {
    'Text/Code files': FILE_TYPE_SUPPORT.text,
    'PDF files': FILE_TYPE_SUPPORT.pdf,
    'Word documents': FILE_TYPE_SUPPORT.word,
    'Excel spreadsheets': FILE_TYPE_SUPPORT.excel,
    'Images (read-only)': FILE_TYPE_SUPPORT.image
  };

  const supported: string[] = [];
  for (const [name, exts] of Object.entries(categories)) {
    const hasAny = exts.some(ext => extensions.includes(ext));
    if (hasAny) {
      if (forEditing && name === 'Images (read-only)') {
        // Skip images for editing
        continue;
      }
      supported.push(name);
    }
  }

  return `Supported file types: ${supported.join(', ')}`;
}

/**
 * Validate that a path is not a directory
 */
export async function validateNotDirectory(filePath: string, fs: any): Promise<void> {
  try {
    const stats = await fs.stat(filePath);
    if (stats.isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${filePath}`);
    }
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    // File doesn't exist yet - that's okay for editing
  }
}

/**
 * Log conversation history to the sandbox directory and return the path
 */
export async function logConversationHistory(
  agentName: string,
  messages: any[],
  fs: any,
  path: any
): Promise<string> {
  // Import getSandboxDir dynamically to avoid circular dependencies
  const { getSandboxDir } = require('../../../utils/sandboxManager');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${agentName}-${timestamp}.json`;
  const logPath = path.join(getSandboxDir(), filename);

  // Ensure directory exists
  const dir = path.dirname(logPath);
  await fs.mkdir(dir, { recursive: true });

  // Write conversation history as JSON
  const conversationData = {
    agent: agentName,
    timestamp: new Date().toISOString(),
    messages
  };

  await fs.writeFile(logPath, JSON.stringify(conversationData, null, 2), 'utf-8');

  return logPath;
}

/**
 * Capture file content for diff comparison
 * Returns plaintext representation for supported file types
 */
export async function captureFileContent(
  filePath: string,
  fs: any
): Promise<{ content: string; raw?: string } | null> {
  const category = getFileCategory(filePath);

  try {
    // Check if file exists
    await fs.access(filePath);
  } catch {
    return null; // File doesn't exist yet
  }

  try {
    switch (category) {
      case 'text': {
        const content = await fs.readFile(filePath, 'utf-8');
        return { content, raw: content };
      }
      case 'word': {
        const { readDocxText } = require('../../../utils/documentText');
        const buffer = await fs.readFile(filePath);
        const plaintext = await readDocxText(buffer);
        return { content: plaintext, raw: buffer.toString('base64') };
      }
      case 'excel': {
        try {
          const { readSpreadsheetTextPreview } = require('../../../utils/spreadsheetText');
          const plaintext = await readSpreadsheetTextPreview(filePath);
          const buffer = await fs.readFile(filePath);
          return { content: plaintext, raw: buffer.toString('base64') };
        } catch (excelError) {
          console.error(`[captureFileContent] Error capturing Excel:`, excelError);
          return { content: '[Excel file - could not capture for diff]' };
        }
      }
      case 'pdf': {
        try {
          const { readPdfStructure } = require('../../../utils/pdfStructure');
          const structure = await readPdfStructure(filePath);
          const plaintext = structure.elements
            .map((element: any) => (
              element.text
              || element.contents
              || (element.fieldName ? `${element.fieldName}: ${element.fieldValue ?? ''}` : '')
            ))
            .filter(Boolean)
            .join('\n');
          const buffer = await fs.readFile(filePath);
          return { content: plaintext, raw: buffer.toString('base64') };
        } catch (pdfError) {
          console.error(`[captureFileContent] Error capturing PDF:`, pdfError);
          return { content: '[PDF file - could not capture for diff]' };
        }
      }
      default:
        return null;
    }
  } catch (error) {
    console.error(`[captureFileContent] Error capturing ${filePath}:`, error);
    return null;
  }
}

/**
 * Generate a simple unified diff between two strings
 */
export function generateSimpleDiff(before: string, after: string, maxLines: number = 50): string {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  const diff: string[] = [];
  let changes = 0;

  // Simple line-by-line diff
  const maxLen = Math.max(beforeLines.length, afterLines.length);

  for (let i = 0; i < maxLen; i++) {
    const beforeLine = beforeLines[i];
    const afterLine = afterLines[i];

    if (beforeLine === afterLine) {
      // Context line (skip for brevity unless near a change)
      continue;
    }

    if (beforeLine !== undefined && afterLine === undefined) {
      diff.push(`- ${beforeLine}`);
      changes++;
    } else if (beforeLine === undefined && afterLine !== undefined) {
      diff.push(`+ ${afterLine}`);
      changes++;
    } else if (beforeLine !== afterLine) {
      diff.push(`- ${beforeLine}`);
      diff.push(`+ ${afterLine}`);
      changes++;
    }

    if (diff.length >= maxLines) {
      diff.push(`... (${maxLen - i - 1} more lines)`);
      break;
    }
  }

  if (changes === 0) {
    return '';
  }

  return diff.join('\n');
}

/**
 * Generate edit feedback message based on before/after content
 */
export function generateEditFeedback(
  filePath: string,
  beforeContent: { content: string; raw?: string } | null,
  afterContent: { content: string; raw?: string } | null
): string {
  const category = getFileCategory(filePath);

  // New file created
  if (!beforeContent && afterContent) {
    const preview = afterContent.content.substring(0, 500);
    return `✓ Created new file\n\nContent preview:\n${preview}${afterContent.content.length > 500 ? '\n...(truncated)' : ''}`;
  }

  // File deleted or couldn't read after
  if (beforeContent && !afterContent) {
    return '⚠️ File was removed or could not be read after editing';
  }

  // Both null - couldn't capture
  if (!beforeContent && !afterContent) {
    return '⚠️ Could not capture file content for diff';
  }

  // Compare content
  const before = beforeContent!.content;
  const after = afterContent!.content;

  if (category === 'word') {
    if (before === after) {
      if (beforeContent!.raw && afterContent!.raw && beforeContent!.raw !== afterContent!.raw) {
        return '✓ Word document modified. Plaintext did not change, so the update likely affected formatting, structure, or metadata.';
      }
      return '⚠️ No changes detected in the Word document. The edit may not have been applied.';
    }

    return '✓ Word document text changed. Plaintext diff omitted because DOCX paragraph extraction can make line-by-line diffs misleading.';
  }

  if (before === after) {
    // No plaintext diff - check raw bytes to detect changes invisible to plaintext extraction
    if (beforeContent!.raw && afterContent!.raw) {
      if (beforeContent!.raw !== afterContent!.raw) {
        return '✓ File was modified (changes not visible in plaintext diff — may affect structure, formatting, or metadata).';
      }
    }
    return '⚠️ No changes detected in the file. The edit may not have been applied. Consider re-running with more specific instructions.';
  }

  // Generate diff
  const diff = generateSimpleDiff(before, after);

  if (diff) {
    return `✓ Changes applied:\n\n\`\`\`diff\n${diff}\n\`\`\``;
  }

  return '✓ File was modified';
}
