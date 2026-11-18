/** Fixed refusal code for input addressed directly to a spawned sub-agent thread. */
export const SUBAGENT_DIRECT_INPUT_UNSUPPORTED = 'subagent_direct_input_unsupported' as const;

/** The runtime's own refusals for direct input to a sub-agent thread. The
 * runtime decides which threads take direct input; only these exact messages
 * are recognised, and any other failure keeps its message. */
const RUNTIME_REFUSALS = [
  'cannot resume an unloaded multi-agent v2 sub-agent through its parent; ' +
    'resume the parent first, or use thread/read to inspect it',
  'direct app-server input is not allowed for multi-agent v2 sub-agents',
] as const;

/** Content-free description of a refusal, safe to return to the caller. */
export type SubagentInputRefusal = {
  code: typeof SUBAGENT_DIRECT_INPUT_UNSUPPORTED;
  threadId: string;
  parentThreadId: string | null;
};

/** A sub-agent thread takes work only through a turn on its parent thread. */
export class SubagentDirectInputError extends Error {
  readonly code = SUBAGENT_DIRECT_INPUT_UNSUPPORTED;
  constructor(readonly threadId: string, readonly parentThreadId: string | null) {
    super(parentThreadId
      ? `Thread ${threadId} is a sub-agent that only takes work through its parent thread ${parentThreadId}; ` +
        'send the message to the parent thread instead.'
      : `Thread ${threadId} is a sub-agent that only takes work through its parent thread; ` +
        'send the message to the parent thread instead.');
    this.name = 'SubagentDirectInputError';
  }
}

export function isSubagentDirectInputRefusal(error: unknown): boolean {
  if (error instanceof SubagentDirectInputError) return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return RUNTIME_REFUSALS.some(phrase => message.includes(phrase));
}
