import { useState, type CSSProperties } from 'react';
import { Eye, MessageSquare, Square } from 'lucide-react';
import type { OverlayDashboardApproval, OverlayRunningAgent } from '../shared/ipc.js';

interface AgentDashboardTrackProps {
  agents: OverlayRunningAgent[];
  approvals?: OverlayDashboardApproval[];
  onReveal: (agentId: string) => void;
  onStop: (agentId: string) => void;
  onSendMessage: (agentId: string, message: string) => void;
  onApproveApproval?: (approvalId: string, rememberForSession: boolean) => void;
  onDenyApproval?: (approvalId: string) => void;
}

export function AgentDashboardTrack({
  agents,
  approvals = [],
  onReveal,
  onStop,
  onSendMessage,
  onApproveApproval,
  onDenyApproval,
}: AgentDashboardTrackProps) {
  const [messageAgentId, setMessageAgentId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  if (agents.length === 0 && approvals.length === 0) {
    return null;
  }

  const activeMessageAgent = agents.find((agent) => agent.agentId === messageAgentId) ?? null;
  const renderApprovalCard = (approval: OverlayDashboardApproval, compact = false) => (
    <article
      key={approval.id}
      className={`agent-dashboard-approval-card${compact ? ' agent-dashboard-approval-card-compact' : ''}`}
      style={{ '--agent-owner-color': approval.ownerColor } as CSSProperties}
    >
      <div className="agent-dashboard-approval-owner">
        <span className="agent-dashboard-approval-dot" aria-hidden="true" />
        <span className="agent-dashboard-approval-owner-name">{approval.ownerDisplayName}</span>
      </div>
      <div className="agent-dashboard-approval-copy">
        <span className="agent-dashboard-approval-title">{approval.title}</span>
        {approval.detail ? (
          <span className="agent-dashboard-approval-detail">{approval.detail}</span>
        ) : null}
      </div>
      {!approval.isSimpleApproval && approval.ownerAgentId ? (
        <div className="agent-dashboard-approval-actions">
          <button
            type="button"
            className="agent-dashboard-approval-button agent-dashboard-approval-approve"
            onClick={() => onReveal(approval.ownerAgentId!)}
          >
            Reveal
          </button>
        </div>
      ) : approval.isSimpleApproval && onApproveApproval && onDenyApproval ? (
        <div className="agent-dashboard-approval-actions">
          <button
            type="button"
            className="agent-dashboard-approval-button"
            onClick={() => onDenyApproval(approval.id)}
          >
            Deny
          </button>
          {approval.supportsSessionApproval && !compact ? (
            <button
              type="button"
              className="agent-dashboard-approval-button"
              onClick={() => onApproveApproval(approval.id, true)}
            >
              Approve session
            </button>
          ) : null}
          <button
            type="button"
            className="agent-dashboard-approval-button agent-dashboard-approval-approve"
            onClick={() => onApproveApproval(approval.id, false)}
          >
            Approve
          </button>
        </div>
      ) : null}
    </article>
  );

  return (
    <section className="agent-dashboard-track" data-interactive="true" aria-label="Running agents">
      {agents.length > 0 ? (
        <div className="agent-dashboard-list">
          {agents.map((agent) => (
            <div className="agent-dashboard-item" key={agent.agentId}>
              {(() => {
                const agentApprovals = approvals.filter((approval) => approval.ownerAgentId === agent.agentId);
                return agentApprovals.length > 0 ? (
                  <div className="agent-dashboard-agent-approvals" aria-label={`Approvals for ${agent.label}`}>
                    {agentApprovals.map((approval) => renderApprovalCard(approval, true))}
                  </div>
                ) : null;
              })()}
              <button
                type="button"
                className="agent-dashboard-summary"
                title="Reveal agent"
                onClick={() => onReveal(agent.agentId)}
              >
                <span className="agent-dashboard-status" aria-hidden="true" />
                <span className="agent-dashboard-copy">
                  <span className="agent-dashboard-label">{agent.label}</span>
                  {agent.latestAction ? (
                    <span className="agent-dashboard-latest">{agent.latestAction}</span>
                  ) : null}
                </span>
                {agent.unreadCount > 0 ? (
                  <span className="agent-dashboard-unread">{agent.unreadCount}</span>
                ) : null}
              </button>
              <button
                type="button"
                className="agent-dashboard-icon-button"
                title="Reveal agent"
                aria-label={`Reveal ${agent.label}`}
                onClick={() => onReveal(agent.agentId)}
              >
                <Eye size={14} strokeWidth={2.2} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="agent-dashboard-icon-button"
                title="Message agent"
                aria-label={`Message ${agent.label}`}
                onClick={() => {
                  setMessageAgentId(agent.agentId);
                  setDraft('');
                }}
              >
                <MessageSquare size={14} strokeWidth={2.2} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="agent-dashboard-icon-button agent-dashboard-stop"
                title="Stop agent"
                aria-label={`Stop ${agent.label}`}
                onClick={() => onStop(agent.agentId)}
              >
                <Square size={13} strokeWidth={2.4} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {approvals.length > 0 ? (
        <div className="agent-dashboard-approval-shelf" aria-label="Pending approvals">
          {approvals.map((approval) => renderApprovalCard(approval))}
        </div>
      ) : null}
      {activeMessageAgent ? (
        <form
          className="agent-dashboard-message"
          onSubmit={(event) => {
            event.preventDefault();
            const message = draft.trim();
            if (!message) {
              return;
            }
            onSendMessage(activeMessageAgent.agentId, message);
            setDraft('');
            setMessageAgentId(null);
          }}
        >
          <input
            className="agent-dashboard-message-input"
            value={draft}
            autoFocus
            aria-label={`Message ${activeMessageAgent.label}`}
            placeholder={`Message ${activeMessageAgent.label}`}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setMessageAgentId(null);
                setDraft('');
              }
            }}
          />
          <button type="submit" className="agent-dashboard-message-send">
            Send
          </button>
        </form>
      ) : null}
    </section>
  );
}
