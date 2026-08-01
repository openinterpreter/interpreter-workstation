/**
 * Automation workflow types.
 *
 * An .automation file is a JSON document describing a sequence of tool calls
 * (blocks) that execute top-to-bottom. Blocks can reference previous block
 * outputs using @blockId.path syntax.
 */

export interface AutomationWorkflow {
  version: 1;
  name: string;
  blocks: AutomationBlock[];
}

/**
 * Per-block context that provides extra configuration for tools that need it.
 * For example, sub-agent tools need a profileId to resolve model configuration.
 */
export interface BlockContext {
  profileId?: string;
}

/** Server IDs whose tools require a profile/model configuration. */
export const AUTOMATION_SERVERS_NEEDING_PROFILE = new Set([
  'builtin-run-agent',
  'builtin-run-agent-ui',
]);

export interface AutomationBlock {
  id: string;
  serverId: string;
  toolName: string;
  label: string;
  inputs: Record<string, any>;
  position: number;
  context?: BlockContext;
}

/** Runtime output stored per-block after execution */
export interface BlockOutput {
  result: any;
  error?: string;
  timestamp: number;
}

/** State managed by the AutomationViewer reducer */
export interface AutomationState {
  workflow: AutomationWorkflow;
  blockOutputs: Record<string, BlockOutput>;
  runningBlockId: string | null;
  runningAll: boolean;
}

export type AutomationAction =
  | { type: 'SET_WORKFLOW'; workflow: AutomationWorkflow }
  | { type: 'SET_NAME'; name: string }
  | { type: 'ADD_BLOCK'; block: AutomationBlock; atPosition: number }
  | { type: 'REMOVE_BLOCK'; blockId: string }
  | { type: 'MOVE_BLOCK'; blockId: string; toPosition: number }
  | { type: 'UPDATE_BLOCK_INPUT'; blockId: string; key: string; value: any }
  | { type: 'UPDATE_BLOCK_LABEL'; blockId: string; label: string }
  | { type: 'UPDATE_BLOCK_CONTEXT'; blockId: string; context: BlockContext }
  | { type: 'SET_BLOCK_OUTPUT'; blockId: string; output: BlockOutput }
  | { type: 'CLEAR_BLOCK_OUTPUT'; blockId: string }
  | { type: 'SET_RUNNING_BLOCK'; blockId: string | null }
  | { type: 'SET_RUNNING_ALL'; running: boolean };

const BLOCK_REF_PATTERN = /@(block_[a-z0-9]+)((?:\.[a-zA-Z_]\w*|\[\d+])*)/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reindexBlocks(blocks: AutomationBlock[]): AutomationBlock[] {
  return blocks.map((block, index) => ({ ...block, position: index }));
}

function clearOutputsFromIndex(
  blocks: AutomationBlock[],
  blockOutputs: Record<string, BlockOutput>,
  startIndex: number,
): Record<string, BlockOutput> {
  if (startIndex < 0) return blockOutputs;

  const affectedIds = new Set(blocks.slice(startIndex).map(block => block.id));
  if (affectedIds.size === 0) return blockOutputs;

  return Object.fromEntries(
    Object.entries(blockOutputs).filter(([blockId]) => !affectedIds.has(blockId)),
  );
}

/**
 * Remove @blockId references from a value if the referenced block is not
 * in the set of allowed (preceding) block IDs.
 */
function stripStaleRefs(value: any, allowedIds: Set<string>): any {
  if (typeof value === 'string') {
    return value.replace(BLOCK_REF_PATTERN, (match, blockId) =>
      allowedIds.has(blockId) ? match : ''
    );
  }
  if (Array.isArray(value)) return value.map(v => stripStaleRefs(v, allowedIds));
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      out[key] = stripStaleRefs(nestedValue, allowedIds);
    }
    return out;
  }
  return value;
}

/**
 * For each block, remove @references to blocks that are not earlier in the list.
 */
function invalidateStaleReferences(blocks: AutomationBlock[]): AutomationBlock[] {
  return blocks.map((block, index) => {
    const precedingIds = new Set(blocks.slice(0, index).map(candidate => candidate.id));
    const sanitizedInputs = stripStaleRefs(block.inputs, precedingIds);
    return sanitizedInputs !== block.inputs ? { ...block, inputs: sanitizedInputs } : block;
  });
}

export function automationReducer(state: AutomationState, action: AutomationAction): AutomationState {
  switch (action.type) {
    case 'SET_WORKFLOW':
      return { ...state, workflow: action.workflow, blockOutputs: {}, runningBlockId: null, runningAll: false };
    case 'SET_NAME':
      return { ...state, workflow: { ...state.workflow, name: action.name } };
    case 'ADD_BLOCK': {
      const blocks = [...state.workflow.blocks];
      blocks.splice(action.atPosition, 0, action.block);
      const reindexed = reindexBlocks(blocks);
      const blockOutputs = clearOutputsFromIndex(reindexed, state.blockOutputs, action.atPosition);
      return { ...state, workflow: { ...state.workflow, blocks: reindexed }, blockOutputs };
    }
    case 'REMOVE_BLOCK': {
      const removedIndex = state.workflow.blocks.findIndex(block => block.id === action.blockId);
      const blocks = state.workflow.blocks.filter(block => block.id !== action.blockId);
      const sanitized = invalidateStaleReferences(reindexBlocks(blocks));
      const blockOutputs = clearOutputsFromIndex(
        sanitized,
        state.blockOutputs,
        removedIndex === -1 ? sanitized.length : removedIndex,
      );
      return { ...state, workflow: { ...state.workflow, blocks: sanitized }, blockOutputs };
    }
    case 'MOVE_BLOCK': {
      const oldIndex = state.workflow.blocks.findIndex(block => block.id === action.blockId);
      if (oldIndex === -1) return state;

      const block = state.workflow.blocks[oldIndex];
      const blocks = state.workflow.blocks.filter(candidate => candidate.id !== action.blockId);
      const insertionIndex = action.toPosition > oldIndex ? action.toPosition - 1 : action.toPosition;
      const boundedIndex = Math.max(0, Math.min(insertionIndex, blocks.length));
      blocks.splice(boundedIndex, 0, block);

      const sanitized = invalidateStaleReferences(reindexBlocks(blocks));
      const firstAffectedIndex = Math.min(oldIndex, boundedIndex);
      const blockOutputs = clearOutputsFromIndex(sanitized, state.blockOutputs, firstAffectedIndex);
      return { ...state, workflow: { ...state.workflow, blocks: sanitized }, blockOutputs };
    }
    case 'UPDATE_BLOCK_INPUT': {
      const blocks = state.workflow.blocks.map(block =>
        block.id === action.blockId ? { ...block, inputs: { ...block.inputs, [action.key]: action.value } } : block
      );
      const changedIndex = blocks.findIndex(block => block.id === action.blockId);
      const blockOutputs = clearOutputsFromIndex(blocks, state.blockOutputs, changedIndex);
      return { ...state, workflow: { ...state.workflow, blocks }, blockOutputs };
    }
    case 'UPDATE_BLOCK_LABEL': {
      const blocks = state.workflow.blocks.map(block =>
        block.id === action.blockId ? { ...block, label: action.label } : block
      );
      return { ...state, workflow: { ...state.workflow, blocks } };
    }
    case 'UPDATE_BLOCK_CONTEXT': {
      const blocks = state.workflow.blocks.map(block =>
        block.id === action.blockId ? { ...block, context: { ...block.context, ...action.context } } : block
      );
      const changedIndex = blocks.findIndex(block => block.id === action.blockId);
      const blockOutputs = clearOutputsFromIndex(blocks, state.blockOutputs, changedIndex);
      return { ...state, workflow: { ...state.workflow, blocks }, blockOutputs };
    }
    case 'SET_BLOCK_OUTPUT':
      return { ...state, blockOutputs: { ...state.blockOutputs, [action.blockId]: action.output } };
    case 'CLEAR_BLOCK_OUTPUT': {
      const { [action.blockId]: _, ...rest } = state.blockOutputs;
      return { ...state, blockOutputs: rest };
    }
    case 'SET_RUNNING_BLOCK':
      return { ...state, runningBlockId: action.blockId };
    case 'SET_RUNNING_ALL':
      return { ...state, runningAll: action.running };
  }
}

/**
 * Built-in constants available in every automation.
 * These are always available in the @ mention dropdown and resolve at runtime.
 */
export interface AutomationConstant {
  /** The @-prefixed key, e.g. "@workspace" */
  id: string;
  /** Display label */
  label: string;
  /** Current resolved value (absolute path, etc.) */
  value: string;
}

export function createEmptyWorkflow(name = 'Untitled Automation'): AutomationWorkflow {
  return { version: 1, name, blocks: [] };
}

export function parseAutomationWorkflow(content: string): AutomationWorkflow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error: any) {
    throw new Error(`Invalid automation JSON: ${error.message || String(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error('Invalid automation workflow: expected a JSON object');
  }
  if (parsed.version !== 1) {
    throw new Error('Invalid automation workflow: expected version 1');
  }
  if (typeof parsed.name !== 'string' || parsed.name.trim() === '') {
    throw new Error('Invalid automation workflow: name must be a non-empty string');
  }
  if (!Array.isArray(parsed.blocks)) {
    throw new Error('Invalid automation workflow: blocks must be an array');
  }

  const blocks = parsed.blocks.map((block, index) => {
    if (!isRecord(block)) {
      throw new Error(`Invalid automation block at index ${index}: expected an object`);
    }
    if (typeof block.id !== 'string' || block.id === '') {
      throw new Error(`Invalid automation block at index ${index}: id must be a non-empty string`);
    }
    if (typeof block.serverId !== 'string' || block.serverId === '') {
      throw new Error(`Invalid automation block ${block.id}: serverId must be a non-empty string`);
    }
    if (typeof block.toolName !== 'string' || block.toolName === '') {
      throw new Error(`Invalid automation block ${block.id}: toolName must be a non-empty string`);
    }
    if (typeof block.label !== 'string' || block.label === '') {
      throw new Error(`Invalid automation block ${block.id}: label must be a non-empty string`);
    }
    if (!Number.isInteger(block.position)) {
      throw new Error(`Invalid automation block ${block.id}: position must be an integer`);
    }
    if (!isRecord(block.inputs)) {
      throw new Error(`Invalid automation block ${block.id}: inputs must be an object`);
    }

    let context: BlockContext | undefined;
    if (block.context !== undefined) {
      if (!isRecord(block.context)) {
        throw new Error(`Invalid automation block ${block.id}: context must be an object`);
      }
      if (block.context.profileId !== undefined && typeof block.context.profileId !== 'string') {
        throw new Error(`Invalid automation block ${block.id}: context.profileId must be a string`);
      }
      context = {
        profileId: typeof block.context.profileId === 'string' ? block.context.profileId : undefined,
      };
    }

    return {
      id: block.id,
      serverId: block.serverId,
      toolName: block.toolName,
      label: block.label,
      inputs: block.inputs as Record<string, any>,
      position: block.position as number,
      context,
    } satisfies AutomationBlock;
  });

  return {
    version: 1,
    name: parsed.name as string,
    blocks: reindexBlocks(blocks),
  };
}

export function generateBlockId(): string {
  return 'block_' + Math.random().toString(36).slice(2, 10);
}
