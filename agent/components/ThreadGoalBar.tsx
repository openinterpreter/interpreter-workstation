import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Loader2, Trash2, X } from 'lucide-react';
import { getApiUrl } from '../../src/ipc';
import type { v2 } from '../../server/handlers/codex-generated-types';
import { THREAD_GOAL_UPDATED_EVENT } from '../utils/threadGoalCommand';
import { ThreadGoalSummary } from './ThreadGoalSummary';

type ThreadGoalBarProps = {
  threadId: string;
  readOnly?: boolean;
};

function isThreadGoal(value: unknown): value is v2.ThreadGoal {
  if (!value || typeof value !== 'object') return false;
  const goal = value as Partial<v2.ThreadGoal>;
  return typeof goal.threadId === 'string'
    && typeof goal.objective === 'string'
    && typeof goal.status === 'string';
}

export function ThreadGoalBar({ threadId, readOnly = false }: ThreadGoalBarProps) {
  return <ThreadGoalBarForThread key={threadId} threadId={threadId} readOnly={readOnly} />;
}

function ThreadGoalBarForThread({ threadId, readOnly = false }: ThreadGoalBarProps) {
  const selectedThreadId = useRef(threadId);
  const readSequence = useRef(0);
  selectedThreadId.current = threadId;
  const [goal, setGoal] = useState<v2.ThreadGoal | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);

  const refresh = useCallback(async (quiet = false) => {
    const sequence = ++readSequence.current;
    const isCurrent = () => selectedThreadId.current === threadId && readSequence.current === sequence;
    if (!quiet) setLoading(true);
    try {
      const response = await fetch(
        await getApiUrl(`/api/agent/threads/${encodeURIComponent(threadId)}/goal`),
        { credentials: 'include' },
      );
      if (!response.ok) throw new Error(`Goal request failed (${response.status})`);
      const payload: unknown = await response.json();
      if (!isCurrent()) return;
      const nextGoal = typeof payload === 'object' && payload !== null
        ? (payload as { goal?: unknown }).goal
        : null;
      const nextAvailable = !(typeof payload === 'object' && payload !== null
        && (payload as { available?: unknown }).available === false);
      if (nextAvailable && nextGoal != null && (!isThreadGoal(nextGoal) || nextGoal.threadId !== threadId)) {
        throw new Error('Invalid native Goal owner');
      }
      setAvailable(nextAvailable);
      setGoal(nextAvailable && isThreadGoal(nextGoal) ? nextGoal : null);
      if (!nextAvailable) setEditing(false);
      if (nextAvailable && isThreadGoal(nextGoal)) setDraft(nextGoal.objective);
      setError(null);
    } catch {
      if (!isCurrent()) return;
      // A failed native read is not evidence that the thread has no Goal.
      setAvailable(false);
      setGoal(null);
      setEditing(false);
      setError('Native Goal controls are unavailable on this host.');
    } finally {
      if (!quiet && isCurrent()) setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    void refresh();
    const intervalId = window.setInterval(() => void refresh(true), 10_000);
    return () => window.clearInterval(intervalId);
  }, [refresh]);

  useEffect(() => {
    const handleGoalUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: string }>).detail;
      if (detail?.threadId === threadId) {
        void refresh(true);
      }
    };

    window.addEventListener(THREAD_GOAL_UPDATED_EVENT, handleGoalUpdated);
    return () => window.removeEventListener(THREAD_GOAL_UPDATED_EVENT, handleGoalUpdated);
  }, [refresh, threadId]);

  const updateGoal = useCallback(async (update: Record<string, unknown>) => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        await getApiUrl(`/api/agent/threads/${encodeURIComponent(threadId)}/goal`),
        {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(update),
        },
      );
      if (!response.ok) {
        throw new Error('Native Goal update was not accepted. The previous Goal may still be active.');
      }
      const payload = await response.json() as { goal?: unknown };
      if (!isThreadGoal(payload.goal) || payload.goal.threadId !== threadId) {
        throw new Error('Invalid goal response');
      }
      setGoal(payload.goal);
      setDraft(payload.goal.objective);
      setEditing(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not update goal');
    } finally {
      setSaving(false);
    }
  }, [threadId]);

  const clearGoal = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        await getApiUrl(`/api/agent/threads/${encodeURIComponent(threadId)}/goal`),
        { method: 'DELETE', credentials: 'include' },
      );
      if (!response.ok) throw new Error(`Goal clear failed (${response.status})`);
      setGoal(null);
      setDraft('');
      setEditing(false);
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : 'Could not clear goal');
    } finally {
      setSaving(false);
    }
  }, [threadId]);

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-[48rem] px-2 sm:px-[var(--unit-padding-medium)]">
        <div
          className="oa-composer-surface oa-interactive-surface flex h-9 w-full shrink-0 items-center gap-2 px-3 text-ui-xs text-[var(--oa-text-faint)]"
          style={{ borderRadius: 'var(--oa-radius-22)' }}
        >
          <Loader2 className="size-3 animate-spin" />
          Loading goal
        </div>
      </div>
    );
  }

  if (editing) {
    return (
      <div className="mx-auto w-full max-w-[48rem] px-2 sm:px-[var(--unit-padding-medium)]">
        <div
          className="oa-composer-surface oa-interactive-surface w-full shrink-0 px-3 py-3"
          style={{ borderRadius: 'var(--oa-radius-22)' }}
        >
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={`thread-goal-${threadId}`} className="text-ui-xs font-medium text-[var(--oa-text-strong)]">
                Goal
              </label>
              <button
                type="button"
                className="rounded-full p-1 text-[var(--oa-text-muted)] hover:bg-[var(--oa-bg-hover)]"
                onClick={() => {
                  setDraft(goal?.objective ?? '');
                  setEditing(false);
                  setError(null);
                }}
                aria-label="Close goal editor"
              >
                <X className="size-3.5" />
              </button>
            </div>
            <textarea
              id={`thread-goal-${threadId}`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={3}
              autoFocus
              placeholder="Describe the outcome this agent should continue working toward"
              className="w-full resize-none rounded-[6.08px] border border-[var(--oa-border)] bg-[var(--oa-bg-input)] px-3 py-2 text-ui-sm leading-5 text-[var(--oa-text)] outline-none focus:border-[var(--oa-text-muted)]"
            />
            {error ? <p className="text-ui-xs text-destructive">{error}</p> : null}
            <div className="flex items-center justify-end gap-2">
              {goal ? (
                <button
                  type="button"
                  onClick={() => void clearGoal()}
                  disabled={saving}
                  className="mr-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-ui-xs text-[var(--oa-text-muted)] hover:bg-[var(--oa-bg-hover)] disabled:opacity-50"
                >
                  <Trash2 className="size-3.5" />
                  Clear
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void updateGoal({ objective: draft.trim(), status: 'active' })}
                disabled={saving || !draft.trim()}
                className="inline-flex items-center gap-1.5 rounded-full bg-[var(--oa-text-strong)] px-3 py-1.5 text-ui-xs font-medium text-[var(--oa-bg-app)] disabled:opacity-40"
              >
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                Save goal
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!available) {
    return (
      <div className="mx-auto w-full max-w-[48rem] px-2 sm:px-[var(--unit-padding-medium)]">
        <div role="status" className="oa-composer-surface px-3 py-2 text-ui-xs text-[var(--oa-text-faint)]"
          style={{ borderRadius: 'var(--oa-radius-22)' }}>
          {error ?? 'Native Goal controls are unavailable on this host.'}
        </div>
      </div>
    );
  }

  if (!goal) {
    return null;
  }

  return (
    <>
      <ThreadGoalSummary
        objective={goal.objective}
        status={goal.status}
        readOnly={readOnly}
        saving={saving}
        onToggleStatus={() => void updateGoal({ status: goal.status === 'active' ? 'paused' : 'active' })}
        onEdit={() => setEditing(true)}
      />
      {error ? <span className="sr-only" role="alert">{error}</span> : null}
    </>
  );
}
