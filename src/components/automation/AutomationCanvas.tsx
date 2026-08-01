import { useState, useCallback } from 'react';
import type { AutomationBlock as AutomationBlockType, AutomationAction, BlockOutput, AutomationConstant } from '../../types/automation';
import type { ToolServer } from '../../api';
import { AutomationBlock } from './AutomationBlock';

/**
 * Shared layout constants for automation components.
 * Use these instead of hardcoded values.
 */
export const AUTOMATION_LAYOUT = {
  /** Horizontal inset for blocks and connectors */
  blockInset: 'var(--content-inset)',
  /** Height of the connector line between blocks */
  connectorHeight: 24,
  /** Height of the drop indicator line */
  dropIndicatorHeight: 2,
} as const;

interface AutomationCanvasProps {
  blocks: AutomationBlockType[];
  servers: ToolServer[];
  dispatch: (action: AutomationAction) => void;
  blockOutputs: Record<string, BlockOutput>;
  runningBlockId: string | null;
  isAnyRunning: boolean;
  onDropTool: (serverId: string, toolName: string, atPosition: number) => void;
  onMoveBlock: (blockId: string, toPosition: number) => void;
  constants: AutomationConstant[];
  workspacePath?: string | null;
}

function getInputSchema(servers: ToolServer[], serverId: string, toolName: string): any {
  const server = servers.find(s => s.id === serverId);
  if (!server?.state.tools) return null;
  const tool = server.state.tools.find(t => t.name === toolName);
  return tool?.inputSchema ?? null;
}

/**
 * Drop zone between blocks (or at edges). Normally invisible; shows a
 * horizontal primary-colored line when a drag enters, indicating where the
 * item will be inserted.
 */
function InsertionZone({
  index,
  onDropTool,
  onMoveBlock,
  showConnector,
}: {
  index: number;
  onDropTool: (serverId: string, toolName: string, atPosition: number) => void;
  onMoveBlock: (blockId: string, toPosition: number) => void;
  /** Whether to draw the vertical connector line through this zone */
  showConnector: boolean;
}) {
  const [active, setActive] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setActive(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.stopPropagation();
    if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
      setActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setActive(false);

    const toolData = e.dataTransfer.getData('application/automation-tool');
    if (toolData) {
      const { serverId, toolName } = JSON.parse(toolData);
      onDropTool(serverId, toolName, index);
      return;
    }

    const blockId = e.dataTransfer.getData('application/automation-block');
    if (blockId) {
      onMoveBlock(blockId, index);
    }
  }, [index, onDropTool, onMoveBlock]);

  return (
    <div
      className="relative"
      style={{ height: showConnector ? AUTOMATION_LAYOUT.connectorHeight : 8, padding: `0 ${AUTOMATION_LAYOUT.blockInset}` }}
      onDragOver={handleDragOver}
      onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Connector line — vertical line centered */}
      {showConnector && (
        <div
          className="absolute left-1/2 top-0 bottom-0"
          style={{ width: 'var(--border-width)', background: 'var(--border)', transform: 'translateX(-50%)' }}
        />
      )}

      {/* Drop indicator — horizontal line that appears on drag */}
      {active && (
        <div
          className="absolute left-0 right-0 top-1/2"
          style={{
            height: AUTOMATION_LAYOUT.dropIndicatorHeight,
            background: 'var(--primary)',
            transform: 'translateY(-50%)',
            marginLeft: AUTOMATION_LAYOUT.blockInset,
            marginRight: AUTOMATION_LAYOUT.blockInset,
            borderRadius: 1,
          }}
        />
      )}
    </div>
  );
}

export function AutomationCanvas({
  blocks,
  servers,
  dispatch,
  blockOutputs,
  runningBlockId,
  isAnyRunning,
  onDropTool,
  onMoveBlock,
  constants,
  workspacePath,
}: AutomationCanvasProps) {
  const [dragOver, setDragOver] = useState(false);

  // The entire canvas is a fallback drop target — drops onto the background append to end
  function handleCanvasDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  }

  function handleCanvasDragLeave(e: React.DragEvent) {
    e.stopPropagation();
    if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOver(false);
    }
  }

  function handleCanvasDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);

    const toolData = e.dataTransfer.getData('application/automation-tool');
    if (toolData) {
      const { serverId, toolName } = JSON.parse(toolData);
      onDropTool(serverId, toolName, blocks.length);
      return;
    }

    const blockId = e.dataTransfer.getData('application/automation-block');
    if (blockId) {
      onMoveBlock(blockId, blocks.length);
    }
  }

  return (
    <div
      className={`flex-1 overflow-auto transition-colors`}
      style={{ paddingTop: 'var(--spacing-md)', paddingBottom: 'var(--spacing-lg)', background: dragOver ? 'color-mix(in oklch, var(--primary) 5%, transparent)' : undefined }}
      onDragOver={handleCanvasDragOver}
      onDragLeave={handleCanvasDragLeave}
      onDrop={handleCanvasDrop}
      onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      {blocks.length === 0 ? (
        <div className="h-full flex flex-col items-center justify-center text-muted-foreground">
          <div className="py-8 text-center">
            <div className="text-ui-base mb-1">No blocks yet</div>
            <div className="text-ui-sm">Click a tool from the palette, or drag one here.</div>
          </div>
        </div>
      ) : (
        <>
          {blocks.map((block, i) => {
            const server = servers.find(s => s.id === block.serverId);
            const inputSchema = getInputSchema(servers, block.serverId, block.toolName);
            const blocksBefore = blocks.slice(0, i);

            return (
              <div key={block.id}>
                {/* Insertion zone: between blocks shows connector, at top just shows drop target */}
                <InsertionZone
                  index={i}
                  onDropTool={onDropTool}
                  onMoveBlock={onMoveBlock}
                  showConnector={i > 0}
                />
                <AutomationBlock
                  block={block}
                  server={server}
                  inputSchema={inputSchema}
                  dispatch={dispatch}
                  blocksBefore={blocksBefore}
                  blockOutputs={blockOutputs}
                  isRunning={runningBlockId === block.id}
                  isAnyRunning={isAnyRunning}
                  constants={constants}
                  workspacePath={workspacePath}
                />
              </div>
            );
          })}
          {/* Final insertion zone after last block */}
          <InsertionZone
            index={blocks.length}
            onDropTool={onDropTool}
            onMoveBlock={onMoveBlock}
            showConnector={false}
          />
          <div style={{ height: 'var(--spacing-lg)' }} />
        </>
      )}
    </div>
  );
}
