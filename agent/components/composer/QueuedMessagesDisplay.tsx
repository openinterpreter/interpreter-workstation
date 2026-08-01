import React from 'react';
import { CornerDownRight } from 'lucide-react';
import {
  QUEUED_MESSAGES_CLEAR_ALL_ID,
  QUEUED_MESSAGES_CONTAINER_ID,
} from '../../../shared/element-ids';
import {
  isAgentPendingInputSteerLocked,
  type AgentPendingInput,
} from '../../../src/stores/agentPendingInputStore';
import { Markdown } from '../prompt-kit/markdown';

interface QueuedMessagesDisplayProps {
  pendingInputs: AgentPendingInput[];
  isStreaming: boolean;
  onEdit: (pendingInputId: string) => void;
  onRemove: (pendingInputId: string) => void;
  onInterruptNow: (pendingInputId: string) => void;
  onQueueForEndOfTurn: (pendingInputId: string) => void;
  onSendAfterNextTool: (pendingInputId: string) => void;
}

function getStageLabel(pendingInput: AgentPendingInput): string {
  switch (pendingInput.stage) {
    case 'afterNextTool':
      return pendingInput.afterNextToolState === 'submitted'
        ? 'Pending'
        : 'Sending';
    case 'interrupting':
      return 'Stopping conversation';
    case 'endOfTurn':
    default:
      return 'Queued conversation';
  }
}

function sortPendingInputs(pendingInputs: AgentPendingInput[]): AgentPendingInput[] {
  const order: Record<AgentPendingInput['stage'], number> = {
    afterNextTool: 0,
    interrupting: 1,
    endOfTurn: 2,
  };

  return [...pendingInputs].sort((a, b) => (
    order[a.stage] - order[b.stage] || a.createdAt - b.createdAt
  ));
}

function PendingMessageActions({
  pendingInput,
  isStreaming,
  onEdit,
  onRemove,
  onInterruptNow,
  onQueueForEndOfTurn,
  onSendAfterNextTool,
}: {
  pendingInput: AgentPendingInput;
  isStreaming: boolean;
  onEdit: (pendingInputId: string) => void;
  onRemove: (pendingInputId: string) => void;
  onInterruptNow: (pendingInputId: string) => void;
  onQueueForEndOfTurn: (pendingInputId: string) => void;
  onSendAfterNextTool: (pendingInputId: string) => void;
}) {
  if (pendingInput.stage === 'afterNextTool' && pendingInput.afterNextToolState === 'submitted') {
    return null;
  }

  const actionClassName = 'rounded-sm px-1 py-0.5 text-ui-sm leading-5 transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]';
  const actionStyle: React.CSSProperties = {
    color: 'var(--oa-text-muted, var(--text-muted))',
  };

  if (pendingInput.stage === 'interrupting') {
    return (
      <div className="flex flex-wrap items-center justify-end gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          className={actionClassName}
          style={actionStyle}
          onClick={() => onQueueForEndOfTurn(pendingInput.id)}
        >
          send at end of turn
        </button>
      </div>
    );
  }

  if (pendingInput.stage === 'afterNextTool') {
    return (
      <div className="flex flex-wrap items-center justify-end gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          className={actionClassName}
          style={actionStyle}
          onClick={() => onInterruptNow(pendingInput.id)}
        >
          send immediately
        </button>
        {!isAgentPendingInputSteerLocked(pendingInput) ? (
          <button
            type="button"
            className={actionClassName}
            style={actionStyle}
            onClick={() => onQueueForEndOfTurn(pendingInput.id)}
          >
            send at end of turn
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      {isStreaming ? (
        <button
          type="button"
          className={actionClassName}
          style={actionStyle}
          onClick={() => onSendAfterNextTool(pendingInput.id)}
        >
          after next tool
        </button>
      ) : null}
      <button
        type="button"
        className={actionClassName}
        style={actionStyle}
        onClick={() => onEdit(pendingInput.id)}
      >
        edit
      </button>
      <button
        type="button"
        data-testid={QUEUED_MESSAGES_CLEAR_ALL_ID}
        className={actionClassName}
        style={actionStyle}
        onClick={() => onRemove(pendingInput.id)}
      >
        remove
      </button>
    </div>
  );
}

export function QueuedMessagesDisplay({
  pendingInputs,
  isStreaming,
  onEdit,
  onRemove,
  onInterruptNow,
  onQueueForEndOfTurn,
  onSendAfterNextTool,
}: QueuedMessagesDisplayProps) {
  if (pendingInputs.length === 0) {
    return null;
  }

  return (
    <div
      data-testid={QUEUED_MESSAGES_CONTAINER_ID}
      className="mx-auto flex w-full max-w-[var(--thread-max-width)] flex-col gap-2 pb-2"
      style={{ padding: '0 var(--unit-padding-medium)' }}
    >
      {sortPendingInputs(pendingInputs).map((pendingInput) => (
        <div key={pendingInput.id} className="group flex justify-end">
          <div className="flex max-w-[min(100%,calc(var(--thread-max-width)*0.72))] flex-col items-end gap-1.5">
            <div
              className="flex items-center gap-2 pr-2 text-ui-base leading-5"
              style={{ color: 'var(--oa-text-muted, var(--text-muted))' }}
            >
              <CornerDownRight className="size-4 shrink-0" strokeWidth={1.8} aria-hidden="true" />
              <span>{getStageLabel(pendingInput)}</span>
            </div>

            <div
              className="thread-message-select w-fit max-w-full"
              style={{
                color: 'var(--oa-text, var(--foreground))',
                background: 'var(--oa-composer-surface, var(--oa-bg-input, var(--background)))',
                border: 'var(--border-width) solid var(--oa-composer-border, var(--oa-border, var(--border)))',
                borderRadius: 'var(--oa-radius-18)',
                padding: '0.5rem 1rem',
                boxShadow: 'var(--oa-shadow-sm, 0 1px 2px rgba(15, 23, 42, 0.04))',
              }}
            >
              <Markdown
                className="oa-user-message-markdown break-words text-[15px] leading-6"
                renderFileCollections={false}
              >
                {pendingInput.previewText}
              </Markdown>
            </div>

            <PendingMessageActions
              pendingInput={pendingInput}
              isStreaming={isStreaming}
              onEdit={onEdit}
              onRemove={onRemove}
              onInterruptNow={onInterruptNow}
              onQueueForEndOfTurn={onQueueForEndOfTurn}
              onSendAfterNextTool={onSendAfterNextTool}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
