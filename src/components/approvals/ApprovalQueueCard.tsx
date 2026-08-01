import { useState } from 'react';
import { Eye } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { QuestionRequest, QuestionResponse, QuestionResult } from '../../../shared/types/approval';
import { APPROVAL_ITEM_ID, APPROVE_BUTTON_ID, DENY_BUTTON_ID } from '../../../shared/element-ids';
import { QuestionPrompt } from '../../../agent/components/composer/ApprovalPromptDock';
import type { ApprovalQueueItem } from '../../lib/approvals/approvalQueue';
import { Button } from '../ui/button';
import {
  ApprovalSupportContent,
  PermissionCardDraftFields,
  initialPermissionCardDraftValues,
  normalizeApprovalCopy,
  permissionCardDraftAnswers,
} from './ApprovalSupportContent';

type ApprovalMode = 'once' | 'session';

interface QuestionSettings {
  enabled: boolean;
  seconds: number;
}

export interface ApprovalQueueCardProps {
  item: ApprovalQueueItem;
  pendingCount: number;
  questionSettings: QuestionSettings;
  onApprove: (id: string, mode: ApprovalMode, approval: QuestionRequest, extraAnswers?: QuestionResponse) => void;
  onDeny: (id: string) => void;
  onQuestionRespond: (id: string, result: QuestionResult) => void | Promise<void>;
  onRevealAgent?: (agentId: string, approval: QuestionRequest) => void;
}

function supportsSessionApproval(approval: QuestionRequest): boolean {
  return approval.context?.sessionAware === true;
}

function getDisplayToolName(approval: QuestionRequest): string {
  return approval.toolName;
}

function getDisplayServerId(approval: QuestionRequest): string {
  return approval.serverId;
}

function getApprovalSummary(approval: QuestionRequest): string {
  if (typeof approval.context?.message === 'string' && approval.context.message.trim()) {
    return normalizeApprovalCopy(approval.context.message);
  }

  if (typeof approval.context?.description === 'string' && approval.context.description.trim()) {
    return normalizeApprovalCopy(approval.context.description);
  }

  return getDisplayToolName(approval);
}

function formatTimestamp(timestamp: number) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.max(0, Math.floor(diff / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

export function ApprovalQueueCard(props: ApprovalQueueCardProps) {
  const { t } = useTranslation();
  const { approval, owner } = props.item;
  const ownerAgentId = owner.agentId ?? undefined;
  const [permissionCardDraft, setPermissionCardDraft] = useState(() => (
    initialPermissionCardDraftValues(approval.context?.permissionCard)
  ));
  const extraAnswers = Object.keys(permissionCardDraft).length > 0
    ? permissionCardDraftAnswers(permissionCardDraft)
    : undefined;
  const approve = (mode: ApprovalMode) => {
    if (extraAnswers) {
      props.onApprove(approval.id, mode, approval, extraAnswers);
      return;
    }
    props.onApprove(approval.id, mode, approval);
  };

  return (
    <div
      className="space-y-3 rounded-[16px] px-3 py-3"
      style={{
        border: 'var(--border-width) solid color-mix(in srgb, var(--oa-border, var(--border)) 28%, transparent)',
        background: 'color-mix(in srgb, var(--oa-bg-app, var(--background)) 90%, var(--oa-bg-subtle, var(--muted)) 10%)',
        boxShadow: `inset 3px 0 0 ${owner.color}`,
      }}
      data-testid={APPROVAL_ITEM_ID(approval.id)}
      data-help-title={t('help.approvals.item.title')}
      data-help-description={t('help.approvals.item.description')}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 text-ui-xs text-[var(--oa-text-muted)]">
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full"
              style={{ background: owner.color }}
            />
            <span className="truncate">{owner.displayName}</span>
            <span className="text-[var(--oa-text-faint)]">/</span>
            <span className="truncate">{getDisplayServerId(approval)}</span>
          </div>
          <div className="mt-1 text-ui-base font-medium text-[var(--oa-text-strong)]">
            {getApprovalSummary(approval)}
          </div>
          {(approval.context?.message || approval.context?.description) && (
            <div className="mt-1 text-ui-sm text-[var(--oa-text-muted)]">
              {getDisplayToolName(approval)}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 self-start">
          {ownerAgentId && props.onRevealAgent && (
            <Button
              type="button"
              variant="utility"
              size="xs"
              className="gap-1"
              data-help-title={t('help.approvals.show.title')}
              data-help-description={t('help.approvals.show.description')}
              onClick={() => props.onRevealAgent?.(ownerAgentId, approval)}
            >
              <Eye className="size-3" />
              <span>Show</span>
            </Button>
          )}
          <div className="whitespace-nowrap text-ui-xs text-[var(--oa-text-faint)]">
            {formatTimestamp(approval.timestamp)}
          </div>
        </div>
      </div>

      {approval.isSimpleApproval ? (
        <>
          <ApprovalSupportContent approval={approval} />
          <PermissionCardDraftFields
            card={approval.context?.permissionCard}
            values={permissionCardDraft}
            onChange={setPermissionCardDraft}
          />

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => props.onDeny(approval.id)}
              variant="utility"
              size="sm"
              className="h-auto max-w-full min-h-[var(--oa-control-h-sm)] justify-start whitespace-normal rounded-[14px] px-4 py-2.5 text-left leading-5 [overflow-wrap:anywhere]"
              data-testid={DENY_BUTTON_ID}
              data-help-title={t('help.approvals.deny.title')}
              data-help-description={t('help.approvals.deny.description')}
            >
              Don&apos;t allow
            </Button>
            <Button
              onClick={() => approve('once')}
              variant="secondary"
              size="sm"
              className="h-auto max-w-full min-h-[var(--oa-control-h-sm)] justify-start whitespace-normal rounded-[14px] px-4 py-2.5 text-left leading-5 [overflow-wrap:anywhere]"
              data-testid={APPROVE_BUTTON_ID}
              data-help-title={t('help.approvals.allowOnce.title')}
              data-help-description={t('help.approvals.allowOnce.description')}
            >
              Allow once
            </Button>
            {supportsSessionApproval(approval) && (
              <Button
                onClick={() => approve('session')}
                variant="default"
                size="sm"
                className="h-auto max-w-full min-h-[var(--oa-control-h-sm)] justify-start whitespace-normal rounded-[14px] px-4 py-2.5 text-left leading-5 [overflow-wrap:anywhere]"
                data-help-title={t('help.approvals.allowSession.title')}
                data-help-description={t('help.approvals.allowSession.description')}
              >
                Allow for this session
              </Button>
            )}
          </div>
        </>
      ) : (
        <QuestionPrompt
          key={approval.id}
          request={approval}
          onRespond={async (result) => {
            await props.onQuestionRespond(approval.id, result);
          }}
          settings={props.questionSettings}
          pendingCount={props.pendingCount}
          busy={false}
        />
      )}
    </div>
  );
}
