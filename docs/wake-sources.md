# Thread wake sources

Automations are inputs to an ordinary persistent thread, not a separate agent or conversation type. Open the thread and expand **Automations** above its composer to add, change, or cancel a schedule or a trusted host command. The dot indicates configured sources; each row displays its next run, current state, and a bounded error. Idle conversations are allowed. An incoming input steers an active turn or starts a turn on **the same thread** when idle; it does not wait in a foreground tool call.

## Schedule

Set an ISO-8601 first time and a message. A repeat interval, if present, must be at least one minute. At most one occurrence per source awaits admission. After confirmed native transcript admission, the next recurrence is calculated from the current time, not the original due time. A restart coalesces missed occurrences into one input; it never catches up an unbounded backlog. Cancelling stops future runs and removes inputs not yet offered. An already offered or admitted turn is not interrupted.

For a daily **civil clock** instead of a fixed elapsed interval, provide `dailyAt` (`HH:mm`) and an IANA `timeZone` such as `America/Los_Angeles`, without `at` or `everyMs`. The next eligible local calendar day is recalculated after admission; the clock time remains stable across daylight-saving changes. On a spring-forward day when that wall time does not exist, that day is skipped. On a fall-back day when a wall time occurs twice, only the first occurrence is used. Restarts coalesce missed days to at most one input and resume on the next eligible local day after admission.

From the conversation itself, `interpreter-app tools builtin-interpreter interpreter_wake_schedule --json '{"action":"list"}'` lists schedules. Use `{"action":"upsert","message":"...","at":"2026-10-01T09:00:00Z"}` to create one, add `everyMs` for recurrence, and supply an existing `id` to change or cancel (`{"action":"cancel","id":"..."}`). This supported tool is scoped to its calling thread; it cannot schedule another conversation.
For daily local time use `{"action":"upsert","message":"...","dailyAt":"07:00","timeZone":"America/Los_Angeles"}` instead of `at`/`everyMs`.

## Trusted command

Configure an absolute executable and JSON array of arguments. This executes on the Workstation host under its own operating-system permissions, without a shell. **Only add a command you trust**; never take an executable or arguments from untrusted inbound text. A command has a two-minute timeout and 64 KiB stdout limit; stderr is not placed in the transcript. Exit 0 must write one UTF-8 JSON object to stdout:

```json
{"id":"source-stable-event-id","message":"An ordinary user input"}
```

`id` must be stable for redelivery of the same upstream event (letters, digits, `_`, `-`). `{ "status": "waiting" }` means no event; the source polls again after at least 30 seconds. A successful event is not rearmed until its marker is confirmed in native thread history, and then has a 30-second minimum interval. Nonzero exit, malformed output, native admission failure, and authentication/usage failures become visible source errors without rapid respawn or model/account fallback. Re-save a corrected source to retry. A host restart recovers an interrupted command; external commands must produce stable IDs so a repeated poll does not cause a second user turn.

## Authenticated event input

For an approved external producer on the same host, configure `WORKSTATION_WAKE_TOKEN` in the private Workstation service environment. POST only to loopback with `Authorization: Bearer <token>` and JSON `{ "sourceId": "source", "eventId": "stable-id", "message": "text" }` at `/api/agent/threads/:threadId/wake-events`. A 202 response confirms **durable custody, not native admission, model response, or outbound delivery**. The source-event pair is deduplicated per thread. GET `/api/agent/threads/:threadId/wake-sources` and wait for the matching event's `status: "admitted"` before acknowledging upstream. Do not put secrets in messages or pass raw third-party content across a trusted-input boundary. This interface must remain on loopback or an authenticated private connection; it is not public ingress.

An operator can inspect native queue custody without starting another runtime: GET `/api/agent/threads/:threadId/native-custody` on loopback using the same bearer token. The existing app-server client reads `thread/read` and paginated `thread/queue/list` and returns only native status, active approval/user-input flags, last turn ID/status, bounded queued-submission IDs and client-message IDs, and count. No input bodies or transcript text are returned. It fails closed on invalid pagination, unavailable native queue support, malformed IDs, or authentication failure. The Workstation host's normal session access policy still applies. This endpoint is **diagnostic**, not an admission acknowledgement or a substitute for maintaining event custody.

The input begins with `[Wake event source/id]`. On restart, the dispatcher checks native history for this marker. If a submission remains ambiguous without a native receipt, it stays offered for operator inspection rather than risking a duplicate user turn; elapsed time alone does not prove rejection. It does not promise exactly-once tool side effects or message delivery. The provider-specific reply tool remains the way to answer; scheduling and input custody are not an outbound queue.

Once admitted, the original message body and transient error are erased from the wake-source state; the compact `(thread, source, event ID)` receipt remains for durable deduplication and status queries. The 10,000-event guard applies only to inputs still awaiting admission, not lifetime admitted messages. Receipts intentionally remain until the thread's data is retired; the private state file grows with unique IDs and should be included in normal Workstation backups. Do not hand-edit it to clear a limit: removing IDs can cause old upstream redeliveries to appear as new input.

## Headless operation

Persist the thread ID on disk and resume that exact native thread after service restart. A missing thread must be repaired explicitly rather than silently replaced. Configure a command source through the same per-thread endpoint or through the Automations editor; do not run a second foreground polling consumer. Use an absolute executable with stable event IDs, and keep source-specific authentication in the provider's private configuration. There is no requirement to keep a Goal or turn running just to receive future input.
