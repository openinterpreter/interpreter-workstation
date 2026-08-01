import type {
  AtomicToolCall,
  ClickParams,
  ComputerBatchParams,
  HotkeyParams,
  ScrollParams,
  TypeParams,
} from './ports.js';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function optionalString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`computer_batch ${key} must be a string.`);
  }
  return value;
}

function optionalNumber(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`computer_batch ${key} must be a finite number.`);
  }
  return value;
}

function optionalBoolean(record: JsonRecord, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`computer_batch ${key} must be a boolean.`);
  }
  return value;
}

function rejectUnknownKeys(record: JsonRecord, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} has unknown key ${JSON.stringify(key)}.`);
    }
  }
}

const TARGET_PARAM_KEYS = [
  'element_id',
  'element_description',
  'x',
  'y',
] as const;
const TARGET_PARAM_KEY_SET = new Set<string>(TARGET_PARAM_KEYS);

function parseTargetParams(record: JsonRecord): ClickParams {
  return {
    element_id: optionalString(record, 'element_id'),
    element_description: optionalString(record, 'element_description'),
    x: optionalNumber(record, 'x'),
    y: optionalNumber(record, 'y'),
  };
}

function stripUndefined<T extends object>(record: T): T {
  for (const key of Object.keys(record) as Array<keyof T>) {
    if (record[key] === undefined) {
      delete record[key];
    }
  }
  return record;
}

export function parseAtomicToolCall(value: unknown, actionLabel: string): AtomicToolCall {
  const tool = requireRecord(value, `${actionLabel}.tool`);
  rejectUnknownKeys(tool, new Set(['name', 'params']), `${actionLabel}.tool`);
  const name = tool.name;
  const params = requireRecord(tool.params, `${actionLabel}.tool.params`);

  if (name === 'click') {
    rejectUnknownKeys(params, TARGET_PARAM_KEY_SET, `${actionLabel}.tool.params`);
    return {
      name,
      params: stripUndefined(parseTargetParams(params)),
    };
  }

  if (name === 'type') {
    rejectUnknownKeys(params, new Set([...TARGET_PARAM_KEYS, 'text', 'clear_first']), `${actionLabel}.tool.params`);
    if (typeof params.text !== 'string') {
      throw new Error(`${actionLabel}.tool.params.text must be a string.`);
    }
    return {
      name,
      params: stripUndefined({
        ...parseTargetParams(params),
        text: params.text,
        clear_first: optionalBoolean(params, 'clear_first'),
      }) as TypeParams,
    };
  }

  if (name === 'hotkey') {
    rejectUnknownKeys(params, new Set(['hotkey']), `${actionLabel}.tool.params`);
    if (typeof params.hotkey !== 'string') {
      throw new Error(`${actionLabel}.tool.params.hotkey must be a string.`);
    }
    return {
      name,
      params: {
        hotkey: params.hotkey,
      } satisfies HotkeyParams,
    };
  }

  if (name === 'scroll') {
    rejectUnknownKeys(params, new Set([...TARGET_PARAM_KEYS, 'direction', 'amount']), `${actionLabel}.tool.params`);
    if (
      params.direction !== 'up'
      && params.direction !== 'down'
      && params.direction !== 'left'
      && params.direction !== 'right'
    ) {
      throw new Error(`${actionLabel}.tool.params.direction must be up, down, left, or right.`);
    }
    return {
      name,
      params: stripUndefined({
        ...parseTargetParams(params),
        direction: params.direction,
        amount: optionalNumber(params, 'amount'),
      }) as ScrollParams,
    };
  }

  throw new Error(`${actionLabel}.tool.name must be click, type, hotkey, or scroll.`);
}

export function parseComputerBatchParams(value: unknown): ComputerBatchParams {
  const root = requireRecord(value, 'computer_batch arguments');
  rejectUnknownKeys(root, new Set(['actions']), 'computer_batch arguments');
  if (!Array.isArray(root.actions) || root.actions.length === 0) {
    throw new Error('computer_batch requires a non-empty actions array.');
  }

  const seenSeq = new Set<number>();
  return {
    actions: root.actions.map((item, index) => {
      const actionLabel = `computer_batch actions[${index}]`;
      const action = requireRecord(item, actionLabel);
      rejectUnknownKeys(action, new Set(['seq', 'tool']), actionLabel);
      if (typeof action.seq !== 'number' || !Number.isFinite(action.seq)) {
        throw new Error(`${actionLabel}.seq must be a finite number.`);
      }
      if (seenSeq.has(action.seq)) {
        throw new Error(`${actionLabel}.seq must be unique.`);
      }
      seenSeq.add(action.seq);
      return {
        seq: action.seq,
        tool: parseAtomicToolCall(action.tool, actionLabel),
      };
    }),
  };
}

export function parseComputerBatchParamsJson(json: string): ComputerBatchParams {
  return parseComputerBatchParams(JSON.parse(json || '{}'));
}
