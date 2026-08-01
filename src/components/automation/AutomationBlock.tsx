import { useState, useCallback, useEffect } from 'react';
import {
  AUTOMATION_SERVERS_NEEDING_PROFILE,
  type AutomationBlock as AutomationBlockType,
  type AutomationAction,
  type BlockOutput as BlockOutputType,
  type AutomationConstant,
} from '../../types/automation';
import type { ToolServer } from '../../api';
import { getProfiles } from '../../api';
import type { Profile } from '../../../shared/types/profile';
import { BlockInputs } from './BlockInputs';
import { BlockOutput } from './BlockOutput';
import { executeBlock } from '../../lib/automationEngine';
import { AUTOMATION_LAYOUT } from './AutomationCanvas';

interface AutomationBlockProps {
  block: AutomationBlockType;
  server: ToolServer | undefined;
  inputSchema: any;
  dispatch: (action: AutomationAction) => void;
  blocksBefore: AutomationBlockType[];
  blockOutputs: Record<string, BlockOutputType>;
  isRunning: boolean;
  isAnyRunning: boolean;
  constants: AutomationConstant[];
  workspacePath?: string | null;
}

export function AutomationBlock({
  block,
  server,
  inputSchema,
  dispatch,
  blocksBefore,
  blockOutputs,
  isRunning,
  isAnyRunning,
  constants,
  workspacePath,
}: AutomationBlockProps) {
  const [isEditing, setIsEditing] = useState(false);
  const output = blockOutputs[block.id];
  const needsProfile = AUTOMATION_SERVERS_NEEDING_PROFILE.has(block.serverId);

  // Load profiles for blocks that need model configuration
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  useEffect(() => {
    if (!needsProfile) return;
    getProfiles().then(({ profiles: p, defaultProfileId: d }) => {
      setProfiles(p);
      setSelectedProfileId(d);
      // Auto-set selected profile if block doesn't have one yet
      if (!block.context?.profileId && d) {
        dispatch({ type: 'UPDATE_BLOCK_CONTEXT', blockId: block.id, context: { profileId: d } });
      }
    });
  }, [needsProfile]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRun = useCallback(async () => {
    if (isAnyRunning) return;
    dispatch({ type: 'SET_RUNNING_BLOCK', blockId: block.id });
    const result = await executeBlock(block, blockOutputs, constants, inputSchema);
    dispatch({ type: 'SET_BLOCK_OUTPUT', blockId: block.id, output: result });
    dispatch({ type: 'SET_RUNNING_BLOCK', blockId: null });
  }, [block, blockOutputs, constants, dispatch, inputSchema, isAnyRunning]);

  return (
    <div
      className="rounded bg-background overflow-hidden"
      style={{
        border: 'var(--border-width) solid var(--border)',
        marginLeft: AUTOMATION_LAYOUT.blockInset,
        marginRight: AUTOMATION_LAYOUT.blockInset,
      }}
    >
      {/* Block Header */}
      <div
        className="flex items-center bg-muted/30"
        style={{
          borderBottom: 'var(--border-width) solid var(--border)',
          gap: 'var(--spacing-xs)',
          padding: `var(--spacing-xs) var(--spacing-sm)`,
          height: 'var(--unit-height-small)',
        }}
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.setData('application/automation-block', block.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
      >
        <span className="text-muted-foreground select-none" title="Drag to reorder">⠿</span>

        {isEditing ? (
          <input
            className="flex-1 px-1 py-0 text-ui-sm bg-background rounded"
            style={{ border: 'var(--border-width) solid var(--border)' }}
            value={block.label}
            onChange={(e) => dispatch({ type: 'UPDATE_BLOCK_LABEL', blockId: block.id, label: e.target.value })}
            onBlur={() => setIsEditing(false)}
            onKeyDown={(e) => e.key === 'Enter' && setIsEditing(false)}
            autoFocus
          />
        ) : (
          <span
            className="flex-1 text-ui-sm font-medium truncate"
            onDoubleClick={() => setIsEditing(true)}
          >
            {block.label}
          </span>
        )}

        <span
          className="text-ui-xs rounded bg-muted text-muted-foreground shrink-0"
          style={{ padding: `var(--padding-sm) var(--spacing-xs)` }}
        >
          {server?.name || block.serverId}
        </span>

        <span className="text-ui-xs text-muted-foreground font-mono shrink-0">
          {block.toolName}
        </span>

        <button
          className="ml-auto text-ui-xs text-muted-foreground shrink-0"
          onClick={() => dispatch({ type: 'REMOVE_BLOCK', blockId: block.id })}
          title="Delete block"
        >
          ✕
        </button>
      </div>

      {/* Block Inputs */}
      <div style={{ paddingTop: 'var(--spacing-xs)' }}>
        <BlockInputs
          block={block}
          inputSchema={inputSchema}
          onUpdateInput={(key, value) =>
            dispatch({ type: 'UPDATE_BLOCK_INPUT', blockId: block.id, key, value })
          }
          blocksBefore={blocksBefore}
          blockOutputs={blockOutputs}
          constants={constants}
          workspacePath={workspacePath}
        />
      </div>

      {/* Context: Profile selector for tools that need model configuration */}
      {needsProfile && profiles.length > 0 && (
        <div style={{ padding: `0 var(--spacing-sm) var(--spacing-xs)` }}>
          <label className="block text-ui-xs text-muted-foreground mb-0.5">
            Model
            <span className="text-destructive ml-0.5">*</span>
            <span className="ml-1 opacity-60">— model configuration for this agent</span>
          </label>
          <select
            className="w-full text-ui-sm bg-background text-foreground rounded"
            style={{
              border: 'var(--border-width) solid var(--border)',
              padding: `var(--padding-sm) var(--spacing-xs)`,
            }}
            value={block.context?.profileId ?? selectedProfileId ?? ''}
            onChange={(e) => dispatch({
              type: 'UPDATE_BLOCK_CONTEXT',
              blockId: block.id,
              context: { profileId: e.target.value || undefined },
            })}
          >
            <option value="">— select model —</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Block Actions */}
      <div
        className="flex items-center"
        style={{ padding: `var(--spacing-xs) var(--spacing-sm)`, gap: 'var(--spacing-xs)' }}
      >
        <button
          className="text-ui-xs rounded bg-primary text-primary-foreground disabled:opacity-50"
          style={{ padding: `var(--padding-sm) var(--spacing-sm)` }}
          onClick={handleRun}
          disabled={isAnyRunning || (needsProfile && !block.context?.profileId)}
        >
          {isRunning ? 'Running...' : 'Run'}
        </button>
        {output && (
          <button
            className="text-ui-xs text-muted-foreground"
            style={{ padding: `var(--padding-sm) var(--spacing-xs)` }}
            onClick={() => dispatch({ type: 'CLEAR_BLOCK_OUTPUT', blockId: block.id })}
          >
            Clear output
          </button>
        )}
      </div>

      {/* Block Output */}
      {output && <BlockOutput output={output} />}
    </div>
  );
}
