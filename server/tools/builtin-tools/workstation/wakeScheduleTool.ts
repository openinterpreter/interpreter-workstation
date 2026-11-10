import { randomUUID } from 'node:crypto';
import type { BuiltinToolDefinition } from '../../builtinTools';
import { readyWakeSources, wakeSources } from '../../../utils/wakeSourcesRuntime';
import { WakeRecoveryError } from '../../../utils/wakeSources';

/** This tool only edits the caller's own ordinary thread. */
export const wakeScheduleTool: BuiltinToolDefinition = {
  name: 'interpreter_wake_schedule',
  description: 'List, inspect, recover future-only daily delivery, reconcile an offered native receipt without replay, add, change, or cancel a time-based input for this conversation.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'config', 'upsert', 'cancel', 'inspect-recovery', 'recover-future', 'reconcile-offered'] },
      id: { type: 'string', description: 'Existing schedule ID for edit/cancel; omit for new schedule.' },
      eventId: { type: 'string', description: 'Exact retained held or offered event ID for a recovery action.' },
      expectedRevision: { type: 'string', description: 'Exact revision from inspect-recovery; stale revisions refuse mutation.' },
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
      if (args.action === 'config') {
        return { content: [{ type: 'text', text: JSON.stringify({
          file: wakeSources.configFilePath(),
          threadId,
          schedules: wakeSources.list(threadId).sources.filter(s => s.kind === 'schedule'),
          edit: 'Use upsert or cancel on this tool; the shared custody file is not a hand-edit interface.',
        }) }] };
      }
      if (args.action === 'inspect-recovery' || args.action === 'recover-future' ||
          args.action === 'reconcile-offered') {
        if (typeof args.id !== 'string') throw new WakeRecoveryError('invalid_request');
        if (args.action !== 'inspect-recovery' &&
            (typeof args.eventId !== 'string' || typeof args.expectedRevision !== 'string')) {
          throw new WakeRecoveryError('invalid_request');
        }
        const snapshot = args.action === 'inspect-recovery'
          ? wakeSources.recoverySnapshot(threadId, args.id)
          : args.action === 'recover-future'
            ? await wakeSources.recoverDailyFuture(threadId, args.id,
              args.expectedRevision as string, args.eventId as string)
            : await wakeSources.reconcileOffered(threadId, args.id,
              args.eventId as string, args.expectedRevision as string);
        if (snapshot.source.kind !== 'schedule') throw new WakeRecoveryError('invalid_request');
        return { content: [{ type: 'text', text: JSON.stringify({
          source: snapshot.source, revision: snapshot.revision,
          events: snapshot.events.map(({ eventId, status, turnId }) => ({ eventId, status, turnId })),
        }) }] };
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
      if (error instanceof WakeRecoveryError) return { content: [{ type: 'text',
        text: JSON.stringify({ available: false, category: error.category }) }], isError: true };
      return { content: [{ type: 'text', text: error instanceof Error ? error.message : 'Schedule operation failed' }], isError: true };
    }
  },
};
