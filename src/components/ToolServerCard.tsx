import { useState } from 'react';
import { NylasUI } from './tool-uis/NylasUI';
import { EchoSecretUI } from './tool-uis/EchoSecretUI';
import { TOOL_SERVER_CARD_ID } from '../../shared/element-ids';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Separator } from './ui/separator';
import { isToolServerDisplayConnected } from '../../shared/toolServerAvailability';

interface ToolConnectionState {
  status: 'disconnected' | 'connecting' | 'connected' | 'failed';
  tools?: Array<{ name: string; description?: string }>;
  resources?: Array<{ uri: string; name?: string }>;
  prompts?: Array<{ name: string; description?: string }>;
  error?: string;
}

interface ToolServerCardProps {
  server: {
    id: string;
    name: string;
    description?: string;
    state: ToolConnectionState;
    config?: {
      transport?: string;
      enabled?: boolean;
    };
  };
  onDelete?: () => void;
  onToggle: () => void;
}

export function ToolServerCard({ server, onDelete, onToggle }: ToolServerCardProps) {
  const [expanded, setExpanded] = useState(false);

  const isRunning = server.state.status === 'connected';
  const isConnected = isToolServerDisplayConnected({ state: server.state });
  const tools = isRunning && server.state.tools ? server.state.tools : [];
  const resources = isRunning && server.state.resources ? server.state.resources : [];

  return (
    <div
      className="bg-background rounded-[var(--control-radius-lg)] p-4"
      style={{ border: 'var(--border-width) solid var(--border)' }}
      data-testid={TOOL_SERVER_CARD_ID}
    >
      <div className="flex flex-col gap-2">
        {/* Title */}
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-ui-base font-medium text-foreground">{server.name}</h3>
          <Badge
            variant={isConnected ? 'default' : server.state.status === 'failed' ? 'destructive' : 'secondary'}
            className={`rounded-full px-2.5 py-0.5 text-ui-xs font-medium${isConnected ? ' bg-emerald-600' : ''}`}
          >
            {isConnected ? 'Connected' :
             server.state.status === 'connected' ? 'No tools' :
             server.state.status === 'connecting' ? 'Connecting...' :
             server.state.status === 'failed' ? 'Failed' : 'Stopped'}
          </Badge>
        </div>

        {server.description && (
          <p className="text-ui-sm text-muted-foreground">{server.description}</p>
        )}

        {server.state.status === 'failed' && (
          <div className="mt-1 p-2 rounded bg-muted">
            <p className="text-ui-sm font-normal text-foreground">Connection Error</p>
            <p className="text-ui-sm text-muted-foreground">{server.state.error || 'Unknown error'}</p>
          </div>
        )}

        {isConnected && (
          <div className="flex gap-3 text-ui-sm text-muted-foreground">
            <span>{tools.length} tools</span>
            <span>{resources.length} resources</span>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2 mt-1">
          <Button
            onClick={onToggle}
            variant="outline"
            size="xs"
          >
            {isRunning ? 'Stop' : 'Start'}
          </Button>
          <Button
            onClick={() => setExpanded(!expanded)}
            variant="ghost"
            size="xs"
          >
            {expanded ? 'Hide' : 'Details'}
          </Button>
          {onDelete && (
            <Button
              onClick={onDelete}
              variant="ghost"
              size="xs"
            >
              Delete
            </Button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="mt-3 pt-3">
          <Separator className="mb-3" />
          {/* Tool-specific UI */}
          {server.id === 'nylas' && <NylasUI serverId={server.id} />}
          {server.id === 'builtin-echo-secret' && <EchoSecretUI serverId={server.id} />}

          {/* Standard tool info (only when connected) */}
          {isRunning && (
            <div>
              {tools.length > 0 && (
                <div className="mb-3">
                  <h4 className="text-ui-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Available Tools</h4>
                  <div className="space-y-1">
                    {tools.map(tool => (
                      <div key={tool.name} className="text-ui-sm break-words">
                        <code className="px-1 py-0.5 rounded bg-muted text-foreground font-mono text-ui-sm">{tool.name}</code>
                        {tool.description && <span className="ml-2 text-muted-foreground">- {tool.description}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {resources.length > 0 && (
                <div>
                  <h4 className="text-ui-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Resources</h4>
                  <div className="space-y-1">
                    {resources.map(resource => (
                      <div key={resource.uri} className="text-ui-sm break-words">
                        <code className="px-1 py-0.5 rounded bg-muted text-foreground font-mono text-ui-sm break-all">{resource.uri}</code>
                        {resource.name && <span className="ml-2 text-muted-foreground">{resource.name}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
