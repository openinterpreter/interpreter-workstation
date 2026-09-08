import { getApiUrl } from '../../src/ipc';

export const THREAD_GOAL_UPDATED_EVENT = 'thread-goal:updated';

export type ThreadGoalCommand =
  | { kind: 'set'; objective: string }
  | { kind: 'clear' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'invalid'; message: string };

export function parseThreadGoalCommand(text: string): ThreadGoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (!match) return null;

  const argument = match[1]?.trim() ?? '';
  if (!argument) {
    return {
      kind: 'invalid',
      message: 'Use /goal followed by an objective, or /goal clear, /goal pause, or /goal resume.',
    };
  }

  const normalized = argument.toLocaleLowerCase('en-US');
  if (normalized === 'clear') return { kind: 'clear' };
  if (normalized === 'pause') return { kind: 'pause' };
  if (normalized === 'resume') return { kind: 'resume' };

  const objective = normalized.startsWith('set ') ? argument.slice(4).trim() : argument;
  if (!objective) {
    return {
      kind: 'invalid',
      message: 'Use /goal followed by an objective, or /goal clear, /goal pause, or /goal resume.',
    };
  }

  return { kind: 'set', objective };
}

export function isThreadGoalCommand(text: string): boolean {
  return parseThreadGoalCommand(text) !== null;
}

async function readGoalError(response: Response, fallback: string): Promise<Error> {
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  return new Error(payload?.error || `${fallback} (${response.status})`);
}

export async function executeThreadGoalCommand(
  threadId: string,
  text: string,
): Promise<Exclude<ThreadGoalCommand, { kind: 'invalid' }>> {
  const command = parseThreadGoalCommand(text);
  if (!command) {
    throw new Error('Not a thread goal command.');
  }
  if (command.kind === 'invalid') {
    throw new Error(command.message);
  }

  const endpoint = await getApiUrl(`/api/agent/threads/${encodeURIComponent(threadId)}/goal`);
  if (command.kind === 'clear') {
    const response = await fetch(endpoint, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (!response.ok) throw await readGoalError(response, 'Could not clear goal');
    return command;
  }

  const response = await fetch(endpoint, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      command.kind === 'set'
        ? { objective: command.objective, status: 'active' }
        : { status: command.kind === 'pause' ? 'paused' : 'active' },
    ),
  });
  if (!response.ok) {
    throw await readGoalError(response, command.kind === 'set' ? 'Could not set goal' : 'Could not update goal');
  }

  return command;
}
