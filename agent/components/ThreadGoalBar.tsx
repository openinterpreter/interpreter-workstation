import { useCallback, useEffect, useState } from 'react';
import { Check, Flag, Loader2, Trash2, X } from 'lucide-react';
import { getApiUrl } from '../../src/ipc';
import type { v2 } from '../../server/handlers/codex-generated-types';
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
  const [goal, setGoal] = useState<v2.ThreadGoal | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch(
        await getApiUrl(`/api/agent/threads/${encodeURIComponent(threadId)}/goal`),
        { credentials: 'include' },
      );
      if (!response.ok) throw new Error(`Goal request failed (${response.status})`);
      const payload: unknown = await response.json();
      const nextGoal = typeof payload === 'object' && payload !== null
        ? (payload as { goal?: unknown }).goal
        : null;
      setGoal(isThreadGoal(nextGoal) ? nextGoal : null);
      if (isThreadGoal(nextGoal)) setDraft(nextGoal.objective);
      setError(null);
    } catch (loadError) {
      if (!quiet) {
        setError(loadError instanceof Error ? loadError.message : 'Could not load goal');
      }
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [threadId]);

  useEffect(() => {
    void refresh();
    const intervalId = window.setInterval(() => void refresh(true), 10_000);
    return () => window.clearInterval(intervalId);
  }, [refresh]);

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
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error ?? `Goal update failed (${response.status})`);
      }
      const payload = await response.json() as { goal?: unknown };
      if (!isThreadGoal(payload.goal)) throw new Error('Invalid goal response');
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
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--oa-border)] px-3 text-ui-xs text-[var(--oa-text-faint)]">
        <Loader2 className="size-3 animate-spin" />
        Loading goal
      </div>
    );
  }

  if (editing) {
    return (
      <div className="shrink-0 border-b border-[var(--oa-border)] bg-[var(--oa-bg-subtle)] px-3 py-3">
        <div className="mx-auto flex max-w-[42rem] flex-col gap-2">
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
    );
  }

  if (!goal) {
    if (readOnly) return null;
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--oa-border)] px-3 text-ui-xs text-[var(--oa-text-muted)] hover:bg-[var(--oa-bg-hover)]"
      >
        <Flag className="size-3.5" />
        Set a goal for this thread
      </button>
    );
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
