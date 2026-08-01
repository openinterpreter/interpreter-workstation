/**
 * ToolDetailView - Detail view for a tool server
 *
 * Shows different content based on tool type:
 * - Built-in: Read-only view of capabilities
 * - MCP: Editable form (uses McpServerForm)
 */

import { cn } from '@/lib/utils';
import { DetailListHeader } from '../ui/detail-list';
import { isToolServerDisplayConnected } from '../../../shared/toolServerAvailability';

import type { ToolServer } from '../../api';

export interface ToolDetailViewProps {
  tool: ToolServer;
  onBack: () => void;
  /** Render custom content (e.g., McpServerForm for MCP servers) */
  renderContent?: () => React.ReactNode;
  renderToolControls?: (toolName: string) => React.ReactNode;
}

export function ToolDetailView({
  tool,
  onBack,
  renderContent,
  renderToolControls,
}: ToolDetailViewProps) {
  const isBuiltin = tool.id.startsWith('builtin-');
  const tools = tool.state.tools || [];
  const isConnected = isToolServerDisplayConnected({
    state: tool.state,
    isBuiltin,
  });
  const isFailed = tool.state.status === 'failed';
  const statusLabel = isConnected
    ? 'connected'
    : tool.state.status === 'connected' && !isBuiltin
      ? 'unavailable'
      : tool.state.status;

  // If custom content is provided (e.g., MCP form), render that plus tools list
  if (renderContent) {
    return (
      <div className="space-y-4">
        <DetailListHeader title={tool.name} onBack={onBack} />
        {renderContent()}

        {/* Tools list for MCP servers */}
        {tools.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-ui-sm font-medium text-muted-foreground">
              Available Tools ({tools.length})
            </h4>
            <div className="space-y-1 max-h-[300px] overflow-y-auto">
              {tools.map((t, i) => (
                <div
                  key={t.name || i}
                  className="p-2 rounded-control"
                  style={{ border: 'var(--border-width) solid var(--border)' }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-ui-sm font-mono text-foreground">
                        {t.name}
                      </div>
                      {t.description && (
                        <div className="text-ui-sm text-muted-foreground mt-0.5">
                          {t.description}
                        </div>
                      )}
                    </div>
                    {renderToolControls?.(t.name)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error message */}
        {isFailed && tool.state.error && (
          <div className="p-2 bg-destructive/10 rounded-control border border-destructive/50"
          style={{ borderWidth: 'var(--border-width)' }}>
            <p className="text-ui-sm text-destructive">
              {tool.state.error}
            </p>
          </div>
        )}
      </div>
    );
  }

  // Default: Built-in tool detail view (read-only)
  return (
    <div className="space-y-4">
      <DetailListHeader title={tool.name} onBack={onBack} />

      {/* Status */}
      <div className="flex items-center gap-3 text-ui-sm">
        <span className="flex items-center gap-1.5">
          <span className={cn(
            'size-1.5 rounded-full shrink-0',
            isConnected ? 'bg-emerald-500' : isFailed ? 'bg-destructive' : 'bg-muted-foreground/50'
          )} />
          <span className={cn(
            isFailed ? 'text-destructive' : 'text-muted-foreground'
          )}>
            {isFailed ? 'Failed' : statusLabel}
          </span>
        </span>
        {isBuiltin && (
          <span className="text-muted-foreground">&middot; Built-in</span>
        )}
      </div>

      {/* Description */}
      {tool.description && (
        <p className="text-ui-sm text-muted-foreground">
          {tool.description}
        </p>
      )}

      {/* Tools list */}
      {tools.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-ui-sm font-medium text-muted-foreground">
            Available Tools ({tools.length})
          </h4>
          <div className="space-y-1 max-h-[300px] overflow-y-auto">
            {tools.map((t, i) => (
              <div
                key={t.name || i}
                className="p-2 rounded-control"
                  style={{ border: 'var(--border-width) solid var(--border)' }}
              >
                <div className="text-ui-sm font-mono text-foreground">
                  {t.name}
                </div>
                {t.description && (
                  <div className="text-ui-sm text-muted-foreground mt-0.5">
                    {t.description}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Error message */}
      {isFailed && tool.state.error && (
        <div className="p-2 bg-destructive/10 rounded-control border border-destructive/50"
          style={{ borderWidth: 'var(--border-width)' }}>
          <p className="text-ui-sm text-destructive">
            {tool.state.error}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * BuiltinToolDetail - Simplified component for built-in tools
 * Just shows the tool list without any editing capabilities
 */
export function BuiltinToolDetail({
  tool,
  onBack,
}: {
  tool: ToolServer;
  onBack: () => void;
}) {
  return <ToolDetailView tool={tool} onBack={onBack} />;
}
