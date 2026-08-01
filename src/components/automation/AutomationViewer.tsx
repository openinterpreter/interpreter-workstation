/**
 * AutomationViewer — top-level viewer for .automation files.
 *
 * Loads/saves the JSON workflow, manages state via useReducer, and composes
 * the toolbar, tool palette, and canvas.
 */

import { useReducer, useEffect, useRef, useCallback, useState, useMemo, type DragEvent } from 'react';
import { readFile, writeFile, getWorkspace } from '../../api';
import { useToolServers } from '../../contexts/ToolServersContext';
import {
  AUTOMATION_SERVERS_NEEDING_PROFILE,
  automationReducer,
  createEmptyWorkflow,
  generateBlockId,
  parseAutomationWorkflow,
  type AutomationState,
  type AutomationConstant,
  type AutomationBlock,
} from '../../types/automation';
import { executeWorkflow } from '../../lib/automationEngine';
import { AutomationToolbar } from './AutomationToolbar';
import { AutomationCanvas } from './AutomationCanvas';
import { ToolPalette } from './ToolPalette';

interface AutomationViewerProps {
  filePath: string;
}

const SAVE_DEBOUNCE_MS = 1000;

const initialState: AutomationState = {
  workflow: createEmptyWorkflow(),
  blockOutputs: {},
  runningBlockId: null,
  runningAll: false,
};

function getAutomationErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function parseAutomationFileContent(content: string): AutomationState['workflow'] {
  if (content.trim().length > 0) {
    return parseAutomationWorkflow(content);
  }
  return createEmptyWorkflow();
}

export function AutomationViewer({ filePath }: AutomationViewerProps) {
  const [state, dispatch] = useReducer(automationReducer, initialState);
  const [saveStatus, setSaveStatus] = useState<'saved' | 'unsaved' | 'saving'>('saved');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { servers } = useToolServers();
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const isAnyRunning = state.runningAll || state.runningBlockId !== null;

  useEffect(() => {
    getWorkspace().then(({ workspace }: { workspace: string | null }) => {
      setWorkspacePath(workspace);
    }).catch(() => {});
  }, []);

  // Built-in constants available in all @ mentions
  const constants = useMemo<AutomationConstant[]>(() => {
    const c: AutomationConstant[] = [];
    if (workspacePath) {
      c.push({ id: '@workspace', label: 'workspace', value: workspacePath });
    }
    return c;
  }, [workspacePath]);

  const saveTimeoutRef = useRef<number | null>(null);
  const lastSavedRef = useRef<string>('');
  const isInitialLoadRef = useRef(true);

  // Load file
  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      let content: string | null = null;
      try {
        const data = await readFile(filePath);
        content = data.content;
      } catch (err: unknown) {
        const message = getAutomationErrorMessage(err);
        if (message === 'File not found') {
          const empty = createEmptyWorkflow();
          dispatch({ type: 'SET_WORKFLOW', workflow: empty });
          lastSavedRef.current = JSON.stringify(empty);
          setError(null);
        } else {
          setError(message);
        }
      }
      if (content !== null) {
        try {
          const parsed = parseAutomationFileContent(content);
          dispatch({ type: 'SET_WORKFLOW', workflow: parsed });
          lastSavedRef.current = JSON.stringify(parsed);
        } catch (err: unknown) {
          setError(getAutomationErrorMessage(err));
        }
      }
      setLoading(false);
      isInitialLoadRef.current = false;
    }
    void load();
  }, [filePath]);

  // Auto-save on workflow changes (debounced)
  useEffect(() => {
    if (isInitialLoadRef.current || loading || error) return;

    const json = JSON.stringify(state.workflow);
    if (json === lastSavedRef.current) return;

    setSaveStatus('unsaved');

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = window.setTimeout(async () => {
      setSaveStatus('saving');
      try {
        const formatted = JSON.stringify(state.workflow, null, 2);
        await writeFile(filePath, formatted);
        lastSavedRef.current = JSON.stringify(state.workflow);
        setSaveStatus('saved');
      } catch {
        setSaveStatus('unsaved');
      }
    }, SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [state.workflow, filePath, loading, error]);

  const getInputSchema = useCallback((block: AutomationBlock) => {
    const server = servers.find(candidate => candidate.id === block.serverId);
    const tool = server?.state.tools?.find(candidate => candidate.name === block.toolName);
    return tool?.inputSchema ?? null;
  }, [servers]);

  const handleDropTool = useCallback((serverId: string, toolName: string, atPosition: number) => {
    const server = servers.find(s => s.id === serverId);
    const tool = server?.state.tools?.find(t => t.name === toolName);
    dispatch({
      type: 'ADD_BLOCK',
      block: {
        id: generateBlockId(),
        serverId,
        toolName,
        label: tool?.description ? `${toolName}` : toolName,
        inputs: {},
        position: atPosition,
      },
      atPosition,
    });
  }, [servers]);

  const handleMoveBlock = useCallback((blockId: string, toPosition: number) => {
    dispatch({ type: 'MOVE_BLOCK', blockId, toPosition });
  }, []);

  // Click a tool in the palette → append block to end
  const handleAddTool = useCallback((serverId: string, toolName: string) => {
    handleDropTool(serverId, toolName, state.workflow.blocks.length);
  }, [handleDropTool, state.workflow.blocks.length]);

  const handleRunAll = useCallback(async () => {
    if (isAnyRunning) return;
    await executeWorkflow(state.workflow.blocks, dispatch, state.blockOutputs, constants, getInputSchema);
  }, [state.workflow.blocks, state.blockOutputs, constants, getInputSchema, isAnyRunning]);

  const hasMissingProfile = state.workflow.blocks.some(block =>
    AUTOMATION_SERVERS_NEEDING_PROFILE.has(block.serverId) && !block.context?.profileId,
  );

  // Stop all drag events from bubbling to PaneView's layout drag system
  const stopDragPropagation = useCallback((e: DragEvent) => {
    // Intercept automation-specific drags (tool palette, block reorder, constant drag)
    if (e.dataTransfer.types.includes('application/automation-tool') ||
        e.dataTransfer.types.includes('application/automation-block') ||
        e.dataTransfer.types.includes('application/automation-constant')) {
      e.stopPropagation();
    }
  }, []);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-ui-sm">
        Loading automation...
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-destructive text-ui-sm">
        {error}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <AutomationToolbar
        name={state.workflow.name}
        onNameChange={(name) => dispatch({ type: 'SET_NAME', name })}
        onRunAll={handleRunAll}
        isRunning={isAnyRunning}
        saveStatus={saveStatus}
        hasMissingProfile={hasMissingProfile}
      />
      <div
        className="flex-1 flex min-h-0"
        onDragStart={stopDragPropagation}
        onDragOver={stopDragPropagation}
        onDragEnter={stopDragPropagation}
        onDragLeave={stopDragPropagation}
        onDrop={stopDragPropagation}
      >
        {/* Tool Palette — left sidebar */}
        <div
          className="w-56 shrink-0 overflow-auto bg-muted/20"
          style={{ borderRight: 'var(--border-width) solid var(--border)' }}
        >
          {/* Constants */}
          {constants.length > 0 && (
            <>
              <div
                className="text-ui-xs font-medium text-muted-foreground uppercase tracking-wider"
                style={{ padding: `var(--spacing-xs) var(--spacing-sm)` }}
              >
                Constants
              </div>
              {constants.map((c) => (
                <div
                  key={c.id}
                  className="text-ui-sm rounded hover:bg-hover"
                  style={{ padding: `var(--spacing-xs) var(--spacing-sm)`, margin: `0 var(--spacing-xs)` }}
                  draggable
                  onDragStart={(e) => {
                    e.stopPropagation();
                    e.dataTransfer.setData(
                      'application/automation-constant',
                      JSON.stringify({ id: c.id, label: c.label, resolvedValue: c.value })
                    );
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  title={c.value}
                >
                  <div className="font-mono text-ui-xs">{c.id}</div>
                  <div className="text-ui-xs text-muted-foreground">{c.value}</div>
                </div>
              ))}
              <div style={{ height: 'var(--spacing-xs)' }} />
            </>
          )}

          {/* Tools */}
          <div
            className="text-ui-xs font-medium text-muted-foreground uppercase tracking-wider"
            style={{ padding: `var(--spacing-xs) var(--spacing-sm)` }}
          >
            Tools
          </div>
          <ToolPalette servers={servers} onAddTool={handleAddTool} />
        </div>

        {/* Canvas */}
        <AutomationCanvas
          blocks={state.workflow.blocks}
          servers={servers}
          dispatch={dispatch}
          blockOutputs={state.blockOutputs}
          runningBlockId={state.runningBlockId}
          isAnyRunning={isAnyRunning}
          onDropTool={handleDropTool}
          onMoveBlock={handleMoveBlock}
          constants={constants}
          workspacePath={workspacePath}
        />
      </div>
    </div>
  );
}
