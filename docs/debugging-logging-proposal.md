# Debugging And Logging Proposal

## Goal

Make the single uploaded `session-*.log` file useful for:

- real user feedback reports
- local `pnpm dev` debugging
- test failure investigation
- grep-based inspection
- LLM-assisted log analysis

The session log should remain the primary support artifact. Improve that file first.

For agent-only debugging, the structured source of truth is the sibling `.agent-events.jsonl` file. The filtered transcript view should be rendered from that event log with `pnpm run agent:log`, not hand-maintained as a separate primary artifact.

## Current State

The current system already works operationally:

- the app writes a session log
- the feedback flow can attach that log
- tests and dev runs also produce log files

The main problems are quality problems:

- too much low-value noise
- inconsistent log shapes
- repeated expected warnings/errors flood the file
- agent-debug signal is not consistently present in the main app path
- docs previously treated `.agent.log` like a primary source even though the real source should be structured agent events

## Recommendation

### 1. Keep one primary support file

Do not replace the feedback log attachment model with a required multi-file bundle.

Keep the uploaded `session-*.log` as the primary artifact. Make that file better.

Optional sidecars can still exist for local debugging or specialized flows, but the session log should be enough to answer most support questions.

### 1a. Keep one structured agent source of truth

Agent transcript/debugging should come from `.agent-events.jsonl`.

- log transcript-worthy events there
- render a filtered transcript from it with `pnpm run agent:log`
- treat `.agent.log` as a derived view, not the source of truth

This keeps the support story simple:

- `session-*.log` for support and broad debugging
- `.agent-events.jsonl` for structured agent inspection
- `pnpm run agent:log` for the clean filtered transcript

### 2. Stay console-first, but make logs deliberate

Do not build a separate logging universe.

Use `console.*` as the transport, but stop treating it like a free-form scratchpad for important events.

Important events should use:

- stable area prefixes
- compact key/value fields
- consistent identifiers
- consistent success/failure fields

Good shape:

```text
[2026-04-03T00:52:55.320Z] [AGENT] turn_start threadId=... agentId=... model=openai/gpt-5.4-mini profileId=...
[2026-04-03T00:52:55.322Z] [TOOL] dispatch threadId=... toolCallId=... tool=read_file target=notes.txt
[2026-04-03T00:52:55.406Z] [TOOL] result threadId=... toolCallId=... tool=read_file ok=true durationMs=84 chars=182
[2026-04-03T00:53:00.150Z] [AGENT] turn_end threadId=... ok=true durationMs=4830 toolCalls=1 warnings=0
```

Bad shape:

```text
thing happened
checking state again
still waiting
loaded pending agent tab requests: {"count":0}
loaded pending agent tab requests: {"count":0}
loaded pending agent tab requests: {"count":0}
```

### 3. Do not add giant metadata headers

Feedback already sends metadata separately:

- `version`
- `platform`
- `arch`
- `email`
- `message`

Do not duplicate that with a large preamble at the top of the log.

Instead, attach context to the events that matter:

- `threadId`
- `agentId`
- `turnId`
- `toolCallId`
- `model`
- `profileId`
- `workspacePath` only when genuinely relevant

This is better for both grep and LLM parsing.

### 4. Log boundaries and summaries, not busywork

The log should emphasize:

- app startup/shutdown
- workspace changes
- agent turn start/end
- tool dispatch/result
- external request start/failure/end
- file watcher lifecycle
- crash/recovery paths
- explicit user-triggered state changes

Avoid or reduce:

- polling loops
- repetitive framework status lines
- repeated expected auth warnings
- repeated approval empty-list checks
- repeated renderer hydration/setup chatter
- highly repetitive Playwright action traces in the main support log

### 5. Rate-limit and summarize repeated noise

If a warning/error can repeat frequently in one session, do not log every occurrence the same way forever.

Prefer:

```text
[WARN_SUMMARY] area=providers.listOpenAIOAuthModels count=14 firstAt=... lastAt=... message="OpenAI OAuth account is not connected"
```

over 14 identical full stack dumps.

Keep the first full occurrence when useful, then summarize repeats.

### 6. Make the main app agent path visible in the session log

The session log should reliably show:

- turn start
- normalized runtime choice
- user message summary
- reasoning start/end if available
- tool call dispatch/result summaries
- assistant completion summary
- turn end status and duration

This should come from the main app agent runtime and its own event sources, not by depending on unrelated runtime stacks.

### 6a. Make agent transcript rendering deterministic

The filtered agent transcript should be renderable from structured events alone. That event stream should include:

- `system`
- visible tool definitions and input schemas
- `user`
- `reasoning`
- `assistant`
- `tool_call`
- `tool_result`
- `tool_error`
- subagent start/end boundaries

That lets humans and agents regenerate the clean transcript at any time without trusting an ad hoc side log.

### 7. Treat test logs as a readability problem, not just a capture problem

For tests:

- keep full raw traces available when needed
- but make the default per-test log readable
- minimize repeated Playwright polling noise
- ensure the session log highlights the test start, main action, and failure summary clearly

The default useful question should be:

> "Why did this test fail?"

not:

> "Can I reconstruct the last 500 low-level waits?"

### 8. Preserve overlay-specific richness where it already exists

Overlay runtime already emits richer transcript/debug artifacts. Keep those for overlay debugging.

But do not let overlay-specific artifacts become the excuse for weak main session logs.

The session log still needs to be strong across the whole app.

## Proposed Logging Rules

### Required for important events

- short stable prefix, for example `[AGENT]`, `[TOOL]`, `[WORKSPACE]`, `[APP]`, `[IPC]`
- one-line summary first
- key/value fields for identifiers and outcomes
- duration when timing matters
- `ok=true|false` for operations with a clear result

### Avoid

- prose-heavy logs
- dumping giant objects unless the object is the thing being debugged
- repeated "loaded X count=0" lines
- logging expected steady-state polling
- logging the same stack trace repeatedly in a tight loop

### Prefer

- one full failure line
- then summarized repeats
- concise args/result summaries
- explicit turn/tool boundaries

## High-Priority Noise To Reduce

Based on recent sampled logs, likely first targets:

- repeated local API Sentry integration chatter
- repeated `providers.listOpenAIOAuthModels` not-connected failures
- approval polling lines with empty results
- repetitive renderer setup/status lines that do not indicate a state change
- excessive Playwright API step spam in the main useful test log

## Suggested Implementation Order

1. Add logging guidance and naming rules.
2. Identify the top 5 noisy callsites and reduce or summarize them.
3. Add structured lifecycle logs for main agent turns and tool calls.
4. Improve test log readability without losing deep traces.
5. Reassess whether any sidecar artifacts are still needed for common support cases.

## Decision Rule

Before adding a log line, ask:

- Will this help explain a user bug report?
- Will this help explain why a test failed?
- Will this help explain why an agent/tool turn failed?
- Is this a state transition or outcome, not just background churn?

If the answer is no, it probably does not belong in the default session log.
