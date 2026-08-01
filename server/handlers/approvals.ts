/**
 * Approvals Handlers
 *
 * THE business logic for approval management.
 * Both Electron IPC and HTTP routes call these same functions.
 */

import { approvalManager } from '../approvalManager';
import type { QuestionResult, QuestionRequest } from '../../shared/types/approval';

// ============================================================================
// Approval Operations
// ============================================================================

export async function getApprovals(toolCallId?: string): Promise<{ approvals: QuestionRequest[] }> {
  const approvals = approvalManager.getApprovals(toolCallId);
  return { approvals };
}

export async function approve(id: string): Promise<{ success: boolean }> {
  approvalManager.approve(id);
  return { success: true };
}

export async function deny(id: string): Promise<{ success: boolean }> {
  approvalManager.deny(id);
  return { success: true };
}

/**
 * Respond to a question/approval request with full result
 * Supports complex questions with multiple answers, skip, and timeout
 */
export async function respond(
  id: string,
  result: QuestionResult
): Promise<{ success: boolean; error?: string }> {
  return approvalManager.respond(id, result);
}
