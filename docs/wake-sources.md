# Thread wake sources

Automations are inputs to an ordinary persistent thread, not a separate agent or conversation type. Open the thread and expand **Automations** above its composer to add, change, or cancel a schedule or a trusted host command. The dot indicates configured sources; each row displays its next run, current state, and a bounded error. Idle conversations are allowed. An incoming input steers an active turn or starts a turn on **the same thread** when idle; it does not wait in a foreground tool call.

## Schedule

Set an ISO-8601 first time and a message. A repeat interval, if present, must be at least one minute. At most one occurrence per source awaits admission. After confirmed native transcript admission, the next recurrence is calculated from the current time, not the original due time. A restart coalesces missed occurrences into one input; it never catches up an unbounded backlog. Cancelling stops future runs and removes inputs not yet offered. An already offered or admitted turn is not interrupted.

For a daily **civil clock** instead of a fixed elapsed interval, provide `dailyAt` (`HH:mm`) and an IANA `timeZone` such as `America/Los_Angeles`, without `at` or `everyMs`. The next eligible local calendar day is recalculated after admission; the clock time remains stable across daylight-saving changes. On a spring-forward day when that wall time does not exist, that day is skipped. On a fall-back day when a wall time occurs twice, only the first occurrence is used. Restarts coalesce missed days to at most one input and resume on the next eligible local day after admission.

From the conversation itself, `interpreter-app tools builtin-interpreter interpreter_wake_schedule --json '{"action":"list"}'` lists schedules. Use `{"action":"upsert","message":"...","at":"2026-10-01T09:00:00Z"}` to create one, add `everyMs` for recurrence, and supply an existing `id` to change or cancel (`{"action":"cancel","id":"..."}`). This supported tool is scoped to its calling thread; it cannot schedule another conversation.
For daily local time use `{"action":"upsert","message":"...","dailyAt":"07:00","timeZone":"America/Los_Angeles"}` instead of `at`/`everyMs`.

For an easy-to-find configuration view in a headless thread, call the same tool with `{"action":"config"}`. It returns that thread's schedule rows and the absolute path of the **single** private `wake-sources.json` state file. The file also contains native admission receipts and command sources: do not hand-edit, replace, or watch it as a second scheduler. To edit a schedule declaratively, keep a small JSON request file with `action`, optional stable `id`, `message`, `dailyAt`, and `timeZone`, and pass it to `interpreter-app tools builtin-interpreter interpreter_wake_schedule --json-file /absolute/path/to/request.json` from **that thread**. `upsert` validates the clock and IANA zone before changing any state, then atomically replaces the same mode-0600 state file (including an fsync of the containing directory); `cancel` retains admitted dedup receipts. `list` and `config` do not write. The request file is an input to this tool, not a second live configuration registry. Restrict its permissions if its message contains private instructions, and do not execute schedule instructions received from untrusted text.

## Trusted command

Configure an absolute executable and JSON array of arguments. This executes on the Workstation host under its own operating-system permissions, without a shell. **Only add a command you trust**; never take an executable or arguments from untrusted inbound text. A command has a two-minute timeout and 64 KiB stdout limit; stderr is not placed in the transcript. Exit 0 must write one UTF-8 JSON object to stdout:

```json
{"id":"source-stable-event-id","message":"An ordinary user input"}
```

`id` must be stable for redelivery of the same upstream event (letters, digits, `_`, `-`). `{ "status": "waiting" }` means no event; the source polls again after at least 30 seconds. A successful event is not rearmed until its marker is confirmed in native thread history, and then has a 30-second minimum interval. Nonzero exit, malformed output, native admission failure, and authentication/usage failures become visible source errors without rapid respawn or model/account fallback. Re-save a corrected source to retry. A host restart recovers an interrupted command; external commands must produce stable IDs so a repeated poll does not cause a second user turn.

## Authenticated event input

For an approved external producer on the same host, configure `WORKSTATION_WAKE_TOKEN` in the private Workstation service environment. POST only to loopback with `Authorization: Bearer <token>` and JSON `{ "sourceId": "source", "eventId": "stable-id", "message": "text" }` at `/api/agent/threads/:threadId/wake-events`. A 202 response confirms **durable custody, not native admission, model response, or outbound delivery**. The source-event pair is deduplicated per thread. GET `/api/agent/threads/:threadId/wake-sources` and wait for the matching event's `status: "admitted"` before acknowledging upstream. Do not put secrets in messages or pass raw third-party content across a trusted-input boundary. This interface must remain on loopback or an authenticated private connection; it is not public ingress.

The producer-neutral mapping is: keep one durable `threadId`; give each upstream input one stable `sourceId`/`eventId` pair; persist or retry that *same* pair until its receipt is `admitted`. A timer, peer or other trusted adapter uses this same route, not a foreground model turn, another agent, or a separate queue consumer. The dispatcher serializes events on that thread, steers the existing active turn using its expected turn ID, and resumes/starts on that same thread when idle. An ambiguous native offer is **not** sent again merely because a connection timed out; inspect native client-message ID and transcript custody or explicitly hold it under the documented operator procedure. Upstream provider delivery and agent completion require separate receipts. This is a local authenticated host contract, not permission to expose an arbitrary remote sender or provider body directly to the agent.

The interactive `/api/agent/chat/steer` path also accepts an optional bounded `clientUserMessageId`, passed unchanged to native `turn/steer` with the expected turn ID. That direct response only identifies a turn; unlike the wake-event route, it does **not** persist an event before admission or implement external-source retry/ordering. Use the durable event route for infrastructure input. Native command execution is distinct from steer: an agent's supported supervised/background command must retain its process/session ID and eventual output/exit, while another event steers the turn; do not restart or duplicate the command to accept a new input. A unit fixture exercises two inputs during an unfinished command, but installed long-command and post-restart native process acceptance remain separate release checks.

## Common native input path

Ordinary interactive streams, direct active-turn steers, and durable timer or
external inputs share Workstation's existing-thread resume policy and native
input submission in `CodexService`. A prepared new chat starts its first turn;
an existing idle chat resumes **that exact thread** before `turn/start`; an
active turn uses `turn/steer` with its expected turn ID. A failed resume does
not substitute a new conversation. Each producer retains its own authentication
and permissions: this common native path does not make an external sender a
desktop tool caller or grant access to a different thread. The interactive
`/api/agent/chat/stream` endpoint may accept a bounded
`clientUserMessageId` supplied by a caller that already persists that identity;
the durable wake route derives and stores one from its thread/source/event ID.
An RPC turn ID alone is not a durable input receipt. Inspect native history for
the exact client ID or marker before acknowledging an external source; an
ambiguous offered input stays in order until independently reconciled or
explicitly held under the operator no-replay procedure. Workstation does not
own native command processes: supported OIX process/session output and exit
continue while a new input is steered, and must not be restarted to accept it.

An operator can inspect native queue custody without starting another runtime: GET `/api/agent/threads/:threadId/native-custody` on loopback using the same bearer token. The existing app-server client reads `thread/read` and paginated `thread/queue/list` and returns only native status, active approval/user-input flags, last turn ID/status, bounded queued-submission IDs and client-message IDs, and count. No input bodies or transcript text are returned. It fails closed on invalid pagination, unavailable native queue support, malformed IDs, or authentication failure. The Workstation host's normal session access policy still applies. This endpoint is **diagnostic**, not an admission acknowledgement or a substitute for maintaining event custody.

For a host-wide pre-restart check, GET `/api/agent/custody/global` on loopback with that same bearer token. This read-only diagnostic counts **all** in-process Workstation message queues, pending agent-tab requests, pending tab startup inputs, created tab requests awaiting completion, and pending approvals without applying the current window/workspace filter. It returns opaque queue owner/request IDs, not queued text or approval details, and fails with 503 instead of an invented empty result when inspection fails. `nativeQueueScope: "thread-only"` explicitly means this endpoint does **not** attest a global native OIX queue: inspect every affected native thread with the separate route above and preserve any unknown custody as a stop condition. An empty per-thread renderer list is not a substitute for the global check. Neither endpoint freezes incoming producers; take a fresh snapshot after coordinating an input checkpoint and immediately before a supervised restart.

To locate the owner of **one already-pending** approval without changing it, GET `/api/agent/custody/approvals/:approvalId?threadId=:threadId` using that bearer token and loopback. An exact pending ID and matching captured owner thread are required; other threads yield 404, regardless of window. If the owner was captured as CLI with no thread binding, use `?cliUnbound=1` with that exact ID instead. A non-CLI unbound request cannot use that exception. The result contains only approval ID, pending status, registered tool name, and captured owner kind/thread/window session/workspace; never tool arguments, questions, provider data, or a disposition capability. Missing/resolved IDs return 404; invalid scope returns 400; unavailable inspection fails 503. The operator must still find the legitimate owner UI/session and obtain its normal approval—these metadata routes cannot approve or deny it.

The input begins with `[Wake event source/id]`. On restart, the dispatcher checks native history for this marker. If a submission remains ambiguous without a native receipt, it stays offered for operator inspection rather than risking a duplicate user turn; elapsed time alone does not prove rejection. It does not promise exactly-once tool side effects or message delivery. The provider-specific reply tool remains the way to answer; scheduling and input custody are not an outbound queue.

New wake submissions also carry a stable native `clientUserMessageId` derived from their thread/source/event identity. Either that ID on a persisted native user message or the exact text marker is an admission receipt; an accepted RPC, a completed turn, or a queue count alone is not. A legacy offered input without either receipt must **not** be retried automatically. For a truly terminal, queue-empty ambiguous offer, the local operator can explicitly choose **not to replay** it: POST `/api/agent/threads/:threadId/wake-events/:sourceId/:eventId/hold` with the same loopback bearer authorization and `{ "turnId": "exact-offered-turn-id", "confirmedNoReplay": true }`. The server rechecks the exact offered event, terminal native turn, idle thread, empty native queue and absence of either receipt before preserving it as `held` (not admitted) and letting later inputs proceed. The held source remains in error for separate review; this operation never acknowledges the upstream provider, restarts the application, or resubmits the held text. If any check fails, stop and reconcile the native receipt rather than calling hold repeatedly. Do not use this endpoint to waive ordinary provider input or skip work without a documented operator decision.

Once admitted, the original message body and transient error are erased from the wake-source state; the compact `(thread, source, event ID)` receipt remains for durable deduplication and status queries. The 10,000-event guard applies only to inputs still awaiting admission, not lifetime admitted messages. Receipts intentionally remain until the thread's data is retired; the private state file grows with unique IDs and should be included in normal Workstation backups. Do not hand-edit it to clear a limit: removing IDs can cause old upstream redeliveries to appear as new input.

An operator-held event is likewise retained with its original text and ID for separate review, but it is **not** an admission or an upstream acknowledgement and cannot be automatically replayed. Its source remains in error; after resolving the missing work, the operator may explicitly re-save that source for future runs without erasing the held ID. Only pending/offered inputs count toward the awaiting-admission limit.

## Headless operation

Persist the thread ID on disk and resume that exact native thread after service restart. A missing thread must be repaired explicitly rather than silently replaced. Configure a command source through the same per-thread endpoint or through the Automations editor; do not run a second foreground polling consumer. Use an absolute executable with stable event IDs, and keep source-specific authentication in the provider's private configuration. There is no requirement to keep a Goal or turn running just to receive future input.

On an idle existing native thread, the wake path retains its original shell
environment and caller scope; it does not mint or install a new shell caller
when resuming a loaded thread. The existing Linux caller binding can recover
its authorization by the token already held in that thread's shell, without
persisting the token itself. A failed or ambiguous native start remains an
offered event for receipt inspection, never an automatic replay. A source-only
fix does not resolve a previously offered event or prove that a running host
has been updated.

If an older saved thread has **no** usable CLI carrier, an authenticated
loopback operator may cold-bind the existing thread with
`POST /api/agent/threads/:threadId/caller/cold-bind` and JSON
`{"workspace":"/absolute/original/workspace"}` using the already-configured
`WORKSTATION_WAKE_TOKEN`. This submits no user input. Every non-cancelled wake
source on the thread must first be paused with a successful source-specific
drain receipt. It rejects active work, native/app queued input, pending approval
or tab request, pending/offered wake events, workspace mismatch, or a previously
restricted tool caller. For a **loaded but idle** thread, the same route uses
OIX's typed `thread/unsubscribe` and waits for OIX's own delayed idle unload
before cold-resuming the **same saved thread ID** with a scoped CLI carrier.
During that bounded transition Workstation denies new ordinary inputs to the
thread; another subscriber, command, turn or queue prevents completion and
fails closed without archiving, replaying or deleting input. Recheck exact
source/native custody after any timeout. Model/provider settings are retained;
no loaded thread has its shell keys changed. Resume paused sources only after
verifying the original caller. A successful response
is **not** proof of model output or that the CLI tool catalog is available in
the next actual turn: inspect `interpreter-app` from that original caller and
then verify a separate new event/turn receipt. An ambiguous response requires
fresh read-only custody, not a blind second bind or input replay.

To temporarily stop new work from one configured source without deleting its record or pending events, POST on loopback to `/api/agent/threads/:threadId/wake-sources/:sourceId/pause`; POST to the corresponding `/resume` path when ready. These local same-origin mutations preserve the source's configuration, next time and sequence, and any pending/offered event. While paused, the dispatcher neither launches a new command nor offers that source's event to native admission. A command already running is **not killed**: pause waits for its output and durable event/error to settle, and waits for the preceding native-offer tick. A successful pause response includes `source` and a bounded `drain` object with `drained: true`, false command/offer in-flight flags, and that source's pending/offered event counts. A drain error leaves the source paused but is **not** a safe stop receipt. This source-specific response is not a global queue, native-turn, or external-provider lease: before stopping a service, separately inspect all sources, native offers/queues, active turns, approvals, and supervised work, then keep exact rollback custody. Pausing does not inspect, freeze or acknowledge an external provider queue, and a provider poll may have made an upstream message temporarily invisible. Do not use DELETE/PUT as a pause/restart substitute: DELETE cancels and discards pending input; PUT edits and resets timing. A paused source must be resumed before it can be edited. As with ordinary admission, verify the event's durable native `admitted` receipt before upstream acknowledgement.
