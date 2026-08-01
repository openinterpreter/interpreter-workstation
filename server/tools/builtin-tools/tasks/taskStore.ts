/**
 * In-memory per-agent task list store.
 *
 * Each agent gets its own task list (keyed by agentId).
 * Tasks are simple descriptions with status tracking —
 * designed so the agent can plan multi-step work and the
 * auto-continuation system can detect incomplete work.
 */

export interface TaskItem {
  id: number;
  description: string;
  status: 'pending' | 'in_progress' | 'done';
}

class TaskStore {
  private tasks = new Map<string, TaskItem[]>();

  /** Create tasks for an agent. Returns the created list. */
  create(agentId: string, items: string[]): TaskItem[] {
    const existing = this.tasks.get(agentId) || [];
    const startId = existing.length > 0 ? Math.max(...existing.map(t => t.id)) + 1 : 1;

    const newTasks: TaskItem[] = items.map((desc, i) => ({
      id: startId + i,
      description: desc,
      status: 'pending' as const,
    }));

    this.tasks.set(agentId, [...existing, ...newTasks]);
    return this.tasks.get(agentId)!;
  }

  /** Update a task's status. Returns the updated task or null if not found. */
  update(agentId: string, taskId: number, status: TaskItem['status']): TaskItem | null {
    const list = this.tasks.get(agentId);
    if (!list) return null;

    const task = list.find(t => t.id === taskId);
    if (!task) return null;

    task.status = status;
    return task;
  }

  /** Get all tasks for an agent. */
  getAll(agentId: string): TaskItem[] {
    return this.tasks.get(agentId) || [];
  }

  /** Get incomplete tasks (pending or in_progress). */
  getIncomplete(agentId: string): TaskItem[] {
    return this.getAll(agentId).filter(t => t.status !== 'done');
  }

  /** Clear all tasks for an agent. */
  clear(agentId: string): void {
    this.tasks.delete(agentId);
  }
}

export const taskStore = new TaskStore();
