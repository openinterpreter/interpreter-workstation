/**
 * Wraps AI SDK tool execute functions to handle large outputs
 *
 * This is for custom tools (like subagent tools) that don't go through
 * the builtin tool converter. They return plain strings instead of MCP format.
 */

import { writeSandboxFile } from './sandboxManager';

const OUTPUT_SIZE_THRESHOLD = 50000; // 50,000 characters

/**
 * Wrap an AI SDK tool's execute function to handle large outputs
 */
export function wrapToolForLargeOutput(
  toolName: string,
  originalExecute: (args: any, context?: any) => Promise<string>
): (args: any, context?: any) => Promise<string> {
  return async (args: any, context?: any) => {
    // Execute the original function
    const result = await originalExecute(args, context);

    // Check if result is too large
    if (result.length <= OUTPUT_SIZE_THRESHOLD) {
      return result;
    }

    // Count lines for the message
    const lineCount = result.split('\n').length;

    // Write large output to sandbox
    const outputPath = await writeSandboxFile(`tool-${toolName}`, result);

    // Return message with clear instructions (like Claude Code does)
    return `Error: Tool output (${result.length.toLocaleString()} characters, ${lineCount.toLocaleString()} lines) exceeds maximum size and has been written to a file.

Output file: ${outputPath}

Use offset and limit parameters to read specific portions:
  read_text_file(path="${outputPath}", offset=0, limit=100) for first 100 lines
  read_text_file(path="${outputPath}", offset=100, limit=100) for lines 100-200

Or use grep to search for specific content:
  grep(pattern="search term", path="${outputPath}", output_mode="content", -C=5)`;
  };
}
