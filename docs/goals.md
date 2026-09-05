# Goals

A Goal is a durable objective attached to one OIX thread. It tells OIX what the
thread should continue working toward across long execution, tool use, and
context compaction. It is not a Workstation scheduler, a queue of replacement
jobs, or a browser polling mechanism.

Workstation is the control surface; OIX owns Goal state, continuation, token and
time accounting, compaction, and terminal status. Because the Goal belongs to
the thread, closing Workstation or a browser does not clear it. Continued work
still requires the OIX process and its persisted home to remain available.

## Create a Goal in Workstation

1. Start a conversation. Once OIX assigns the thread id, a **Set a goal for
   this thread** row appears above the conversation.
2. Select it, describe the concrete outcome, and choose **Save goal**.
3. Workstation creates the native OIX Goal as `active`. The Goal row stays above
   the transcript and shows its current status.
4. Use the pause/resume control to change whether OIX should continue, the edit
   control to replace the objective, or **Clear** to remove the Goal entirely.

Goal creation has no implicit token budget. The HTTP API supports an optional
positive `tokenBudget` for callers that need one; omitting it lets OIX use its
normal account and runtime limits.

A useful objective is explicit about completion and quality. For example:

> Process every item in the input manifest, create a verified output for each
> one, maintain a durable progress index, and stop only when all items pass the
> acceptance checks.

Avoid objectives such as “keep busy” or “work on this forever.” A measurable
completion condition helps the agent recover after compaction, distinguish a
temporary blocker from completion, and audit what remains.

## Statuses

| Status | Meaning |
| --- | --- |
| `active` | OIX may continue pursuing the objective. |
| `paused` | Continuation is intentionally paused and can be resumed. |
| `blocked` | Progress requires outside input or a state change. |
| `usageLimited` | The account or provider usage limit stopped progress. |
| `budgetLimited` | The Goal's explicit token budget was reached. |
| `complete` | OIX determined that the stated objective is finished. |

`blocked`, `usageLimited`, and `budgetLimited` are failures to continue, not
successful completion. Workstation displays the native status rather than
inventing a second idle timer or supervisor state.

## Persistence and reconnection

Persist the OIX home directory and the workspace used by the thread. The OIX
rollout is the durable conversation record; Workstation loads the newest page
first and retrieves older history as the user scrolls upward. The same thread
id restores its Goal after an app, renderer, or browser reconnect.

An authenticated browser Workstation uses these same Goal controls when its
host is read-write. A read-only host shows the objective and status but rejects
Goal mutations. An anonymous public publication receives only the objective
and status in its allowlisted snapshot. Create, edit, pause, resume, or clear a
Goal from a trusted read-write Workstation connection.

## HTTP API

Workstation's trusted sidecar exposes native Goal operations at:

```text
GET    /api/agent/threads/:threadId/goal
PUT    /api/agent/threads/:threadId/goal
DELETE /api/agent/threads/:threadId/goal
```

`PUT` accepts `objective`, `status`, and optional `tokenBudget`. The read-only
host policy rejects `PUT` and `DELETE`, and the public relay does not forward
these routes at all. The OIX app-server methods underneath them are
`thread/goal/get`, `thread/goal/set`, and `thread/goal/clear`.
