import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

function readOverlayService(): string {
  return fs.readFileSync(path.join(import.meta.dir, 'service.ts'), 'utf8');
}

function readRunEngine(): string {
  return fs.readFileSync(path.join(import.meta.dir, '../runtime/core/run-engine.ts'), 'utf8');
}

function extractMethod(source: string, methodName: string): string {
  const methodStart = source.indexOf(methodName);
  expect(methodStart).toBeGreaterThanOrEqual(0);
  const methodEnd = source.indexOf('\n  private ', methodStart + 1);
  expect(methodEnd).toBeGreaterThan(methodStart);
  return source.slice(methodStart, methodEnd);
}

describe('overlay approval and computer_batch review separation contract', () => {
  test('keeps computer_batch review state out of ApprovalManager', () => {
    const runEngineSource = readRunEngine();
    const computerBatchMethod = extractMethod(runEngineSource, 'private async handleComputerBatchTool');

    expect(runEngineSource).not.toContain('approvalManager');
    expect(runEngineSource).not.toContain('globalApproval');
    expect(computerBatchMethod).toContain('this.pendingComputerBatch = {');
    expect(computerBatchMethod).toContain("this.updateUI(false, null, 'computer-batch-staged')");
    expect(computerBatchMethod).not.toContain('approvalManager');
    expect(computerBatchMethod).not.toContain('createApproval');
    expect(computerBatchMethod).not.toContain('globalApproval');
  });

  test('keeps global approval responses on ApprovalManager instead of action review controls', () => {
    const serviceSource = readOverlayService();
    const approveMethod = extractMethod(serviceSource, 'private approveGlobalApproval');
    const denyMethod = extractMethod(serviceSource, 'private denyGlobalApproval');

    expect(approveMethod).toContain('approvalManager.respond');
    expect(denyMethod).toContain('approvalManager.respond');
    expect(approveMethod).not.toContain('pendingComputerBatch');
    expect(denyMethod).not.toContain('pendingComputerBatch');
    expect(approveMethod).not.toContain('handleCtrl');
    expect(denyMethod).not.toContain('handleCtrl');
    expect(approveMethod).not.toContain('replacePendingComputerBatchForNewProposal');
    expect(denyMethod).not.toContain('replacePendingComputerBatchForNewProposal');
  });

  test('keeps overlay global approval as an ApprovalManager projection bridge', () => {
    const serviceSource = readOverlayService();
    const summarizeMethod = extractMethod(serviceSource, 'private summarizeOverlayApproval');
    const refreshMethod = extractMethod(serviceSource, 'private refreshGlobalApprovalState');

    expect(refreshMethod).toContain('approvalManager');
    expect(refreshMethod).toContain('getApprovalsForOverlayAgents');
    expect(refreshMethod).toContain('this.overlayApprovalAgentIds');
    expect(refreshMethod).toContain('this.advancedVoice.advancedVoiceAgent?.threadId');
    expect(refreshMethod).toContain('this.summarizeOverlayApproval(approval)');
    expect(refreshMethod).toContain('this.send({ globalApproval: nextApproval })');
    expect(refreshMethod).not.toContain('createApproval');
    expect(refreshMethod).not.toContain('createQuestion');
    expect(refreshMethod).not.toContain('new Map');

    expect(summarizeMethod).toContain('id: approval.id');
    expect(summarizeMethod).toContain('title,');
    expect(summarizeMethod).toContain('detail,');
    expect(summarizeMethod).toContain('supportsSessionApproval: context.sessionAware === true');
    expect(summarizeMethod).not.toContain('ApprovalQueueCard');
    expect(summarizeMethod).not.toContain('buildApprovalQueueItems');
  });

  test('marks native CUA execution as reviewed only from accepted computer_batch actions', () => {
    const serviceSource = readOverlayService();
    const directNativeMethod = extractMethod(serviceSource, 'private async executeNativeCuaOverlayToolCall');
    const activeNativeMethod = extractMethod(serviceSource, 'private async executeNativeCuaToolCallForActiveOverlaySession');
    const driverClickMethod = extractMethod(serviceSource, 'click: async (session, request): Promise<void> => {');

    expect(directNativeMethod).toContain('overlayReviewedAction: options.reviewedOverlayAction === true');
    expect(activeNativeMethod).toContain('{ reviewedOverlayAction: true }');
    expect(driverClickMethod).not.toContain('reviewedOverlayAction: true');
  });
});
