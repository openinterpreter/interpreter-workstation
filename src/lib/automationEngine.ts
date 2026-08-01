/**
 * Automation execution engine.
 *
 * Resolves @blockId.path references and runs blocks sequentially via callTool().
 */

import { callTool } from '../api';
import {
  AUTOMATION_SERVERS_NEEDING_PROFILE,
  type AutomationAction,
  type AutomationBlock,
  type AutomationConstant,
  type BlockOutput,
} from '../types/automation';

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
};

export interface AutomationValidationError {
  field: string;
  message: string;
}

type ToolExecutor = (
  serverId: string,
  toolName: string,
  args: Record<string, any>,
  toolContext?: { profileId?: string },
) => Promise<any>;

/**
 * Walk a dot/bracket path like "content[0].text" on an object.
 */
export function getByPath(obj: any, path: string): any {
  const segments = path.replace(/\[(\d+)]/g, '.$1').split('.');
  let current = obj;
  for (const seg of segments) {
    if (current == null) return undefined;
    current = current[seg];
  }
  return current;
}

/**
 * Find all @blockId.path references in a string.
 */
const REF_PATTERN = /@(block_[a-z0-9]+)((?:\.[a-zA-Z_]\w*|\[\d+])*)/g;

function isEmptyValue(value: unknown): boolean {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

function collectUnresolvedReferences(value: any): string[] {
  if (typeof value === 'string') {
    return Array.from(value.matchAll(REF_PATTERN), match => match[0]);
  }
  if (Array.isArray(value)) {
    return value.flatMap(item => collectUnresolvedReferences(item));
  }
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(item => collectUnresolvedReferences(item));
  }
  return [];
}

function validateResolvedValue(
  schema: JsonSchema | undefined,
  value: unknown,
  fieldPath: string,
  errors: AutomationValidationError[],
): void {
  if (!schema || !schema.type) return;

  if (schema.type === 'object') {
    if (value == null) return;
    if (typeof value !== 'object' || Array.isArray(value)) {
      errors.push({ field: fieldPath, message: `${fieldPath} must resolve to an object` });
      return;
    }

    const requiredFields = schema.required ?? [];
    for (const key of requiredFields) {
      const nestedValue = (value as Record<string, unknown>)[key];
      if (isEmptyValue(nestedValue)) {
        errors.push({ field: `${fieldPath}.${key}`, message: `${fieldPath}.${key} is required` });
      }
    }

    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      validateResolvedValue(childSchema, (value as Record<string, unknown>)[key], `${fieldPath}.${key}`, errors);
    }
  }
}

export function validateBlockExecution(
  block: AutomationBlock,
  resolvedInputs: Record<string, any>,
  inputSchema?: JsonSchema | null,
): AutomationValidationError[] {
  const errors: AutomationValidationError[] = [];
  const requiredFields = inputSchema?.required ?? [];

  for (const key of requiredFields) {
    if (isEmptyValue(resolvedInputs[key])) {
      errors.push({ field: key, message: `${key} is required` });
    }
  }

  for (const unresolvedRef of collectUnresolvedReferences(resolvedInputs)) {
    errors.push({
      field: 'references',
      message: `Unresolved reference: ${unresolvedRef}`,
    });
  }

  for (const [key, schema] of Object.entries(inputSchema?.properties ?? {})) {
    validateResolvedValue(schema, resolvedInputs[key], key, errors);
  }

  if (AUTOMATION_SERVERS_NEEDING_PROFILE.has(block.serverId) && !block.context?.profileId) {
    errors.push({
      field: 'context.profileId',
      message: 'This tool requires a model/profile selection',
    });
  }

  return errors;
}

/**
 * Resolve @blockId.path references and @constant references in a single value.
 * - Strings: replace inline refs. If the entire string is one ref, return the raw value (preserving type).
 * - Objects/arrays: recurse.
 * - Primitives: pass through.
 *
 * Constants are matched by exact known IDs (e.g. "@workspace") rather than
 * word-boundary regex, because mention chips serialize directly adjacent to
 * following text (e.g. "@workspace/test.txt") with no delimiter.
 */
export function resolveReferences(
  value: any,
  blockOutputs: Record<string, BlockOutput>,
  constants: AutomationConstant[] = []
): any {
  if (typeof value === 'string') {
    let result = value;

    const sortedConstants = [...constants].sort((a, b) => b.id.length - a.id.length);
    for (const constant of sortedConstants) {
      if (!result.includes(constant.id)) continue;
      result = result.split(constant.id).join(constant.value);
    }

    const trimmedResult = result.trim();
    const fullMatch = trimmedResult.match(/^@(block_[a-z0-9]+)((?:\.[a-zA-Z_]\w*|\[\d+])*)$/);
    if (fullMatch) {
      const [, blockId, pathStr] = fullMatch;
      const output = blockOutputs[blockId];
      if (!output) return result;
      return pathStr ? getByPath(output.result, pathStr.slice(1)) : output.result;
    }

    return result.replace(REF_PATTERN, (match, blockId, pathStr) => {
      const output = blockOutputs[blockId];
      if (!output) return match;
      const resolved = pathStr ? getByPath(output.result, pathStr.slice(1)) : output.result;
      return resolved != null ? String(resolved) : match;
    });
  }

  if (Array.isArray(value)) {
    return value.map(item => resolveReferences(item, blockOutputs, constants));
  }

  if (value && typeof value === 'object') {
    const result: Record<string, any> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      result[key] = resolveReferences(nestedValue, blockOutputs, constants);
    }
    return result;
  }

  return value;
}

/**
 * Collect available output paths from previous blocks for autocomplete.
 * Returns a flat list of "@blockId.path" strings.
 */
export function collectOutputPaths(
  blockOutputs: Record<string, BlockOutput>,
  blocksBefore: AutomationBlock[],
  maxDepth = 3
): string[] {
  const paths: string[] = [];

  function walk(obj: any, prefix: string, depth: number) {
    if (depth > maxDepth || obj == null) return;

    if (Array.isArray(obj)) {
      obj.forEach((item, index) => {
        const path = `${prefix}[${index}]`;
        paths.push(path);
        if (typeof item === 'object' && item != null) {
          walk(item, path, depth + 1);
        }
      });
    } else if (typeof obj === 'object') {
      for (const key of Object.keys(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        paths.push(path);
        if (typeof obj[key] === 'object' && obj[key] != null) {
          walk(obj[key], path, depth + 1);
        }
      }
    }
  }

  for (const block of blocksBefore) {
    const output = blockOutputs[block.id];
    if (!output) continue;
    paths.push(`@${block.id}`);
    walk(output.result, `@${block.id}`, 0);
  }

  return paths;
}

/**
 * Execute a single block: resolve refs → validate → callTool → return output.
 */
export async function executeBlock(
  block: AutomationBlock,
  blockOutputs: Record<string, BlockOutput>,
  constants: AutomationConstant[] = [],
  inputSchema?: JsonSchema | null,
  executeTool: ToolExecutor = callTool,
): Promise<BlockOutput> {
  const resolvedInputs = resolveReferences(block.inputs, blockOutputs, constants);
  const validationErrors = validateBlockExecution(block, resolvedInputs, inputSchema);
  if (validationErrors.length > 0) {
    return {
      result: null,
      error: validationErrors.map(error => error.message).join('\n'),
      timestamp: Date.now(),
    };
  }

  const toolContext = block.context?.profileId ? { profileId: block.context.profileId } : undefined;
  try {
    const result = await executeTool(block.serverId, block.toolName, resolvedInputs, toolContext);
    return { result, timestamp: Date.now() };
  } catch (err: any) {
    return { result: null, error: err.message || String(err), timestamp: Date.now() };
  }
}

/**
 * Execute all blocks sequentially, dispatching state updates as we go.
 * Stops on first error.
 */
export async function executeWorkflow(
  blocks: AutomationBlock[],
  dispatch: (action: AutomationAction) => void,
  existingOutputs: Record<string, BlockOutput>,
  constants: AutomationConstant[] = [],
  getInputSchema?: (block: AutomationBlock) => JsonSchema | null | undefined,
  executeTool: ToolExecutor = callTool,
): Promise<void> {
  dispatch({ type: 'SET_RUNNING_ALL', running: true });
  const outputs = { ...existingOutputs };

  for (const block of blocks) {
    dispatch({ type: 'SET_RUNNING_BLOCK', blockId: block.id });
    const output = await executeBlock(
      block,
      outputs,
      constants,
      getInputSchema?.(block),
      executeTool,
    );
    outputs[block.id] = output;
    dispatch({ type: 'SET_BLOCK_OUTPUT', blockId: block.id, output });

    if (output.error) {
      dispatch({ type: 'SET_RUNNING_BLOCK', blockId: null });
      dispatch({ type: 'SET_RUNNING_ALL', running: false });
      return;
    }
  }

  dispatch({ type: 'SET_RUNNING_BLOCK', blockId: null });
  dispatch({ type: 'SET_RUNNING_ALL', running: false });
}
