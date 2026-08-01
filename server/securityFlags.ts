/**
 * Pre-launch security hardening flags.
 *
 * These are intentionally code-level constants (not runtime env toggles)
 * so pre-launch hardening remains on by default in all environments.
 */

/**
 * Disable tool execution entry points that are reachable over HTTP.
 *
 * Covered endpoints:
 * - /mcp
 * - /api/ipc/servers/callTool
 */
export const PRELAUNCH_SECURITY_DISABLE_HTTP_TOOL_EXECUTION = true;
