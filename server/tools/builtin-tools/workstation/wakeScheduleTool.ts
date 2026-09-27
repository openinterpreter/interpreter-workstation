import { randomUUID } from 'node:crypto';
import type { BuiltinToolDefinition } from '../../builtinTools';
import { readyWakeSources, wakeSources } from '../../../utils/wakeSourcesRuntime';

/** This tool only edits the caller's own ordinary thread. */
export const wakeScheduleTool: BuiltinToolDefinition = {
  name: 'interpreter_wake_schedule',
  description: 'List, add, change, or cancel a time-based user input for this conversation. One-time, interval, and IANA-zone daily schedules wake the same thread; missed occurrences coalesce.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'upsert', 'cancel'] },
      id: { type: 'string', description: 'Existing schedule ID for edit/cancel; omit for new schedule.' },
      message: { type: 'string', description: 'User input to send when due.' },
      at: { type: 'string', description: 'ISO-8601 date and time of first occurrence.' },
      everyMs: { type: 'integer', minimum: 60000, description: 'Optional recurring interval in milliseconds; omit for one-time.' },
      dailyAt: { type: 'string', description: 'Optional daily local wall time in HH:mm, paired with timeZone instead of at/everyMs.' },
      timeZone: { type: 'string', description: 'IANA time zone, e.g. America/Los_Angeles, paired with dailyAt.' },
    },
    required: ['action'],
  },
  mode: 'write',
  mainAgentOnly: true,
  handler: async (args, context) => {
    const threadId = context?.threadId;
    if (!threadId) return { content: [{ type: 'text', text: 'A current thread is required.' }], isError: true };
    try {
      await readyWakeSources();
      if (args.action === 'list') {
        return { content: [{ type: 'text', text: JSON.stringify(wakeSources.list(threadId).sources.filter(s => s.kind === 'schedule')) }] };
      }
      if (args.action === 'cancel') {
        if (typeof args.id !== 'string') throw new Error('Schedule ID required');
        const source = wakeSources.list(threadId).sources.find(s => s.id === args.id && s.kind === 'schedule');
        if (!source) throw new Error('Schedule not found');
        await wakeSources.cancel(threadId, args.id);
        return { content: [{ type: 'text', text: `Cancelled schedule ${args.id}` }] };
      }
      if (args.action !== 'upsert') throw new Error('Unknown action');
      const source = await wakeSources.put({
        id: typeof args.id === 'string' ? args.id : randomUUID(),
        threadId, kind: 'schedule', message: args.message, at: args.at,
        ...(args.everyMs === undefined ? {} : { everyMs: args.everyMs }),
        ...(args.dailyAt === undefined ? {} : { dailyAt: args.dailyAt }),
        ...(args.timeZone === undefined ? {} : { timeZone: args.timeZone }),
      });
      return { content: [{ type: 'text', text: JSON.stringify(source) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Schedule operation failed' }], isError: true };
    }
  },
};
