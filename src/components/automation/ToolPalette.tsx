import type { ToolServer } from '../../api';
import { isToolServerAgentAccessible } from '../../../shared/toolServerAvailability';

interface ToolPaletteProps {
  servers: ToolServer[];
  onAddTool: (serverId: string, toolName: string) => void;
}

export function ToolPalette({ servers, onAddTool }: ToolPaletteProps) {
  // Only show connected servers with tools
  const connectedServers = servers.filter(
    s => isToolServerAgentAccessible(s.state)
  );

  if (connectedServers.length === 0) {
    return (
      <div className="text-ui-xs text-muted-foreground" style={{ padding: 'var(--spacing-sm)' }}>
        No connected tool servers. Connect a server in Settings to see available tools.
      </div>
    );
  }

  return (
    <div className="overflow-auto">
      {connectedServers.map((server) => (
        <div key={server.id} style={{ marginBottom: 'var(--spacing-xs)' }}>
          <div
            className="text-ui-xs font-medium text-muted-foreground uppercase tracking-wider"
            style={{ padding: `var(--spacing-xs) var(--spacing-sm)` }}
          >
            {server.name}
          </div>
          {server.state.tools!.map((tool) => (
            <div
              key={`${server.id}:${tool.name}`}
              className="text-ui-sm rounded hover:bg-hover active:bg-muted"
              style={{ padding: `var(--spacing-xs) var(--spacing-sm)`, margin: `0 var(--spacing-xs)` }}
              draggable
              onClick={() => onAddTool(server.id, tool.name)}
              onDragStart={(e) => {
                e.stopPropagation();
                e.dataTransfer.setData(
                  'application/automation-tool',
                  JSON.stringify({ serverId: server.id, toolName: tool.name })
                );
                e.dataTransfer.effectAllowed = 'copy';
              }}
              title={tool.description || tool.name}
            >
              <div className="font-mono text-ui-xs">{tool.name}</div>
              {tool.description && (
                <div className="text-ui-xs text-muted-foreground truncate">{tool.description}</div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
