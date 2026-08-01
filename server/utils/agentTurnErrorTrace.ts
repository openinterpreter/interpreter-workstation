type AgentTurnErrorTraceContext = {
  agentId?: string | null;
  durationMs: number;
  model?: string | null;
  profileId?: string | null;
  provider?: string | null;
  requestThreadId?: string | null;
  resolvedThreadId?: string | null;
  selection?: string | null;
  turnId?: string | null;
};

function serializeUnknown(value: unknown, depth = 0): unknown {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return value;
  }

  if (value instanceof Error) {
    return serializeError(value, depth + 1);
  }

  if (Array.isArray(value)) {
    if (depth >= 2) {
      return `[array(${value.length})]`;
    }
    return value.slice(0, 10).map((entry) => serializeUnknown(entry, depth + 1));
  }

  if (typeof value === 'object') {
    if (depth >= 2) {
      return '[object]';
    }
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record)
        .slice(0, 20)
        .map(([key, entry]) => [key, serializeUnknown(entry, depth + 1)]),
    );
  }

  return String(value);
}

function serializeError(error: Error, depth = 0): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack ?? null,
  };

  if ('cause' in error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause !== undefined) {
      serialized.cause = depth >= 2 ? String(cause) : serializeUnknown(cause, depth + 1);
    }
  }

  return serialized;
}

export function buildAgentTurnErrorTrace(
  error: unknown,
  context: AgentTurnErrorTraceContext,
): string {
  const trace = {
    agentId: context.agentId ?? null,
    durationMs: context.durationMs,
    error: serializeUnknown(error),
    model: context.model ?? null,
    profileId: context.profileId ?? null,
    provider: context.provider ?? null,
    requestThreadId: context.requestThreadId ?? null,
    resolvedThreadId: context.resolvedThreadId ?? null,
    selection: context.selection ?? null,
    turnId: context.turnId ?? null,
  };

  return JSON.stringify(trace);
}
