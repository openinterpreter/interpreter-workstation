/**
 * Handles large tool outputs by truncating and writing full content to sandbox
 *
 * This wrapper intercepts tool results and:
 * 1. Checks if the output exceeds a size threshold
 * 2. Shows first portion, then truncation warning with % omitted
 * 3. Writes the FULL output to a sandbox file
 * 4. Ends with grep/read commands so the agent can access the rest
 *
 * IMPORTANT: Read is handled differently - it FAILS instead of
 * being truncated. This is intentional because truncating file reads creates
 * confusion. The agent should grep inside large files or use the read subagent.
 * See readFileContentTool.ts for that handling.
 */

import { writeSandboxFile } from './sandboxManager';
import { noteSandboxAccessAllowed } from './sandboxPermissions';

/**
 * Size threshold for truncation (20,000 characters)
 * Any output exceeding this will be truncated
 */
export const OUTPUT_SIZE_THRESHOLD = 20000;

/**
 * How much to show from the start when truncating
 */
const TRUNCATE_PREVIEW_SIZE = 8000; // ~8k chars from start

/**
 * MCP tool result format
 */
interface ToolResult {
  content: Array<{
    type: string;
    text?: string;
    [key: string]: any;
  }>;
  isError?: boolean;
}


/**
 * Extract all text content from a tool result
 * Returns the concatenated text from all text parts
 */
function extractTextContent(result: ToolResult): string {
  const textParts: string[] = [];

  for (const item of result.content) {
    if (item.type === 'text' && item.text) {
      textParts.push(item.text);
    }
  }

  return textParts.join('\n\n');
}

/**
 * Calculate the total number of characters in all text content in a tool result
 */
function calculateResultSize(result: ToolResult): number {
  return extractTextContent(result).length;
}

/**
 * Wrap a tool result, truncating if too large
 *
 * @param toolName - Name of the tool that produced this result
 * @param result - The tool result from the handler
 * @param agentId - Optional agent ID to ensure it has read access to the output
 * @returns Modified result (or original if not too large)
 */
export async function handleLargeOutput(
  toolName: string,
  result: ToolResult,
  agentId?: string
): Promise<ToolResult> {
  const totalSize = calculateResultSize(result);

  // If the result is small enough, return it as-is
  if (totalSize <= OUTPUT_SIZE_THRESHOLD) {
    return result;
  }

  // Result is too large - extract content and prepare truncated version
  const fullContent = extractTextContent(result);

  // Write full content to sandbox
  const outputPath = await writeSandboxFile(`tool-${toolName}`, fullContent);

  // Ensure the agent has read access to the sandbox
  if (agentId) {
    noteSandboxAccessAllowed(agentId);
  }

  // Create truncated preview: first portion → truncation warning → commands to access full output
  const firstPart = fullContent.slice(0, TRUNCATE_PREVIEW_SIZE);

  // Calculate what percentage of the document is being omitted
  const percentShown = Math.round((TRUNCATE_PREVIEW_SIZE / totalSize) * 100);
  const percentOmitted = 100 - percentShown;
  const omittedChars = totalSize - TRUNCATE_PREVIEW_SIZE;

  const truncatedContent = firstPart + `

... [TRUNCATED - ${percentOmitted}% of content omitted (${omittedChars.toLocaleString()} characters)] ...

Full output written to: ${outputPath}

To explore the complete output:
- Use grep to search: grep(pattern="search term", path="${outputPath}")
- Read specific portions: Read(path="${outputPath}", offset=0, limit=100)`;

  return {
    content: [{
      type: 'text',
      text: truncatedContent
    }],
    isError: result.isError
  };
}
