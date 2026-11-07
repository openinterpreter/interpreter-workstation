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

1. Start a conversation so OIX assigns the thread id.
2. Enter `/goal <objective>` in the composer. Workstation writes the native OIX
   Goal as `active` and does not send the slash command to the model.
3. The compact Goal card appears in the accessory stack immediately above the
   composer, alongside any active Plan card.
4. Use `/goal pause`, `/goal resume`, or `/goal clear` for lifecycle changes.
   The card also provides pause/resume, edit, and clear controls when the host
   is read-write.

The bare `/goal` command reports its usage locally. Goal commands are available
after a thread id exists; read-only and public web surfaces show the same bottom
accessory location but do not expose mutation controls.

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

## Programmatic task receipts

For an authenticated saved-thread task, assign one stable
`clientUserMessageId` before sending it. A broken progress stream is not proof
that the native turn failed to start. Workstation binds progress arriving before
the `turn/start` response only after that response identifies the exact turn;
notifications from an older turn are not completion receipts for the new task.
If the progress observer fails, the native turn can continue independently.

Use the authenticated, exact-thread and exact-client-ID custody read at
`GET /api/agent/threads/:threadId/submissions/:clientUserMessageId/custody`
to distinguish a recorded request, an observed native user item, a native
queue item, and an unverified or timed-out inspection. A request receipt alone
does not prove a model response, a command result, or external delivery. A
timeout does not cancel an outstanding native call and must not cause a blind
retry with a different client ID. Saved command records also do not establish
whether an operating-system process remains live.
