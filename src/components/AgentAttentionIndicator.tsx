import type { AgentIndicatorTone } from '../../shared/utils/agentAttention';

function getIndicatorColor(tone: AgentIndicatorTone): string {
  switch (tone) {
    case 'attention':
      return 'var(--agent-indicator-attention)';
    case 'running':
      return 'var(--agent-indicator-running)';
    case 'unread':
      return 'var(--agent-indicator-unread)';
    default:
      return 'var(--agent-indicator-idle)';
  }
}

export function AgentAttentionIndicator({
  tone,
  className = 'size-1.5',
}: {
  tone: AgentIndicatorTone;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`block rounded-full flex-shrink-0 ${tone === 'running' ? 'animate-blink' : ''} ${className}`}
      style={{ backgroundColor: getIndicatorColor(tone) }}
    />
  );
}
