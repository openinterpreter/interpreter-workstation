# Interpreter Overlay and Computer-Use Architecture

This is the durable architecture contract for the overlay, computer-use,
permission, and realtime surfaces.

Read this before implementing anything in these areas. If code and this document disagree, treat this document as the intent: either fix the code or amend this document deliberately — never drift silently.

Companion documents:

- `docs/agent-tools.md`, `docs/agent-ipc.md`, `docs/agent-frontend.md`, `docs/agent-testing.md`, `docs/browser-extension.md` — area rules that still apply.

## Product shape

- The overlay is the primary interface. The main window is a Chrome-like agent surface; the overlay is how Interpreter meets the user anywhere on the desktop.
- There is one overlay agent experience. No mode picker, no automatic route picker, no separate execution personas. Form filling is tool behavior inside the unified overlay agent, not a separate agent identity or user-facing mode.
- Selection is context acquisition, not an execution mode. A user-selected region, app, window, tab, file, or document is treated as if the controller already ran the appropriate inspect/read tool for that target. After that, the model uses the same unified computer tools it would use for refs it acquired itself.
- Selection is user state, defined broadly: a dragged screen region, the current app/window, selected browser text/elements, selected files, an editor or document selection, or a region inside an app. The UI may draw a boundary or ripple over it, but execution still goes through the unified computer API.

## Tool surface

- Production model-facing app tools are CLI-only through `interpreter-app`. The shared runtime starts app turns with `mcp_servers: {}`. Do not add or revive direct app-tool execution paths.
- `ToolManager.callTool()` is the single app-side execution choke point for built-in tools and app-managed MCP-backed tools.
- One tool definition source: each `BuiltinToolDefinition` feeds Interpreter CLI help, normal agent-facing descriptions, and the fast realtime/text-controller catalogs. Never create a second overlay-only description list.
- Every caller — normal agents, typed overlay controller, realtime audio bridge, hidden agents, windowed agents, the CLI — reaches the same tool definitions and execution layer. The model-facing shape may be restricted per caller, but the execution path is shared.
- Overlay-scoped exception: the attached overlay control agent and the realtime voice desktop agent may keep narrow product-internal primitives for their tightly scoped control loops (context reads, screenshots, reviewed batch actions, attachment queries, delegated handoff). This exception never extends to normal workstation agents or production app turns.

## OIX runtime contract

- Open Interpreter (OIX) owns provider, model, and harness compatibility. The app consumes the `interpreter/provider/list`, `interpreter/model/list`, and `interpreter/harness/list` app-server methods and passes the chosen model provider, model, and optional harness as per-thread configuration.
- An omitted harness means Automatic: OIX chooses its compatible recommended harness from the provider/model pair. `harness: null` means explicit native Codex. A string means the exact OIX harness id. The app must never overwrite an omitted choice with native Codex.
- Profile selection is app-owned persistence; do not mutate OIX's global active provider/model/harness merely to start an app thread. This keeps concurrent agents independently configurable and avoids cross-profile races.
- The bundled unified OIX `bin/interpreter` executable is a signed, pinned runtime boundary; Workstation starts its `app-server` subcommand for the agent protocol. App changes must not patch a user's Open Interpreter checkout. OIX source changes require their own reviewed runtime change and pin/schema regeneration.
- The pinned public OIX runtime uses the multithread Tokio wrapper required by its cache/image path, so Workstation must not blanket-disable native `tools.view_image`. The permission-scoped app-owned `read_image` Interpreter tool remains an additional capability for explicitly routing a local file through the profile's configured vision model.

## Computer action model

- The unified CUA/computer catalog owns computer-control actions: native CUA refs, browser refs, screenshots, window controls, tab/page controls, selection reads. The overlay owns capture, current selection/context, review UI, traces, and lifecycle — it must not own a separate control execution namespace.
- Primitives stay atomic. Screen info in, basic computer actions out. One tool call must not secretly perform multiple user-level actions, hide recovery logic, or retry silently. If behavior needs multiple steps, expose multiple explicit primitives and let the model choose.
- `computer_batch` is the ordered multi-action envelope, not a separate capability surface. Canonical schema: `actions[]` with a unique finite `seq` and either a selected-target `tool` or a normal Interpreter `server_id` / `tool_name` / `arguments` call. The complete envelope is strictly validated before its first action runs. Selected-target actions cross the visible overlay action-review surface; normal Interpreter calls cross `ToolManager` and their own scoped permission/grant boundary. Read-only calls need no consent, and an existing structured grant may satisfy a normal tool's permission check. The batch executor dispatches to the single shared implementation of each primitive; it never duplicates them or implies that native permission approval and overlay action review are the same surface.
- `computer_batch` result contract (amended 2026-07-06, supersedes the 2026-07-05 amendment): the batch tool is implemented once on the unified CLI tool layer (`interpreter-app` builtin) and runs a batch array of actions. The result is per-action results plus, for CUA actions, the before/after DIFF of each window the batch touched — what changed, never a full context dump. The model only knows what changed unless it explicitly calls a read tool (e.g. `overlay_read_context`) for full current state. Because the realtime and Groq controllers are just callers of this same tool, they inherit this behavior automatically — no controller-side variant, and loop conversation size stays flat across laps.
- Refs are current-observation handles, never durable ids. Model-facing actions use refs from the latest observed context (`element_token` / `element_index`, browser `ref_id`). Stale or unknown refs fail loudly and return fresh context plus reread guidance. The model contract must not require overlay snapshot ids, session ids, or generation counters on actions.
- Loose tool JSON from fast models is handled in two strict steps: first local normalization of the one safe mechanical mistake (wrapping a single canonical action into `actions[]`), with every correction reported back to the model; then, if still invalid, the raw arguments plus exact schemas go to the configured fast repair model, which must return valid schema-shaped arguments or an explicit rejection. Field aliases and unknown keys are rejected. Never execute unvalidated repaired JSON; never guess executor behavior.
- Model-facing structured context stays raw and honest: observed elements, raw AX-derived attributes, visible text, geometry, focus state. No inferred label ownership, no semantic backfilling, no meaning the runtime cannot observe.

## Selection and current context

- Current-selection state is app-owned internal state, not a model-facing mode or action argument. It lets the system remember what the user selected, reread the relevant AX/CUA/browser/page/document context, and return compact refreshed context after actions.
- The current selection/context packet carries: normalized target identity, permission scope, compact selectable refs with bounds, selected file refs, selected text refs, screen bounds, and capture time.
- Target identity is normalized across sources: target kind, app/process/window identity, browser profile/window/tab/frame identity where applicable, document identity where applicable, display id, coordinate space, scale, bounds, capture time, and permission scope.
- Typed input, realtime audio, hidden agents, and windowed agents all receive the same packet. Context parity between text and audio is a tested contract, not an aspiration.

## Controllers and transports

- v1 typed input: a tight fast text-controller loop. A tiny deterministic direct-command table for obvious explicit commands backed by real primitives, then fast-model planning with the shared tool catalog. Managed short-lived conversation context is scoped to owner plus target, capped, and pruned on inactivity, target change, or explicit clear. Stale selected refs never silently carry into a new target.
- v1 audio: the hosted GPT realtime 2 transport stays separate from typed input. It receives the same selection/context packet and a deliberately restricted high-leverage tool subset: the reviewed batch envelope, selection/attachment reads, and hidden-agent handoff. Transport adapters (attachment query, agent-message reads) are bridge mechanics, not separate execution paths.
- The realtime model must know when to stop going locally: broad filesystem/project work, unsupported app-specific tools, or complex planning hand off to the hidden agent with the same selected context instead of improvising.
- Speech-commit is not execution approval. While speech input is open, actionful tools return not-executed status. After commit, proposed actions still require action review or an existing structured grant. There is no auto-fire in v1; a future countdown auto-fire mode must be an explicit opt-in with a visible cancel window (see the Living Permission Queue phase).
- Voice-mode lifetime is user-controlled. A completed assistant turn never detaches the selected target or shuts down voice mode; only the user or a fatal error does.
- Turn completion and selection lifecycle are different operations. Clearing transient thinking/drawing UI for a finished turn must not destroy selected context.

## Delegation and agent windows

- Hidden agents perform delegated work under the caller's permission owner: approvals key to the parent owner reference, not a throwaway hidden-agent id. Hidden agents keep their own internal child metadata, and their progress/cancel affordances surface under the parent agent in the dashboard and tray.
- Launched windowed agents get their own owner id, with `parentOwnerId` retained for UI and history.
- Both receive the same current selection/context packet, target refs, and refreshed-context loop as the caller — never just a prose summary or an overlay-only handle.
- Agent windows are part of the computer API: list windowed agents with safe metadata, launch a visible agent, reveal/focus, send messages, await completion, stop, close. Results never expose caller tokens, prompts, attachments, or full message history.

## Permissions and approvals

- `AgentPermissionIdentity` / `ApprovalOwnerSnapshot` identify every approval: owner kind (normal agent, overlay agent, hidden agent, extension action, CLI), display name, deterministic color, agent/thread/window/workspace identity, tool profile, and parent owner when delegated.
- `ApprovalManager` is the single approval queue and `QuestionRequest` the single card data model. Never create a second queue.
- Session approvals use the canonical structured key `{ v, ownerId, sourceKind, serverId, capabilityId, workspacePath, windowSessionKey, targetScope }`. Session grants narrow to owner plus capability plus normalized observable target scope. They never broaden global ceilings, never fall back to the active window/workspace implicitly, and never key on display labels.
- Per-agent permissions narrow the global ceiling, never broaden it. Every model-facing execution path respects the effective per-agent file scope.
- Card placement rule (adopted 2026-07-05): when the requesting agent's window is active, the full card renders inline there. The global track always shows compact summaries of all pending items across agents, color-coded by owner. Complex or editable cards expand from their summary on reveal.
- Consent cards and display cards are distinct classes on shared card infrastructure. Content/display cards (search results, generated media, status) must not share the reflex dismissal gesture or visual identity of consent cards; users must never be trained to blast through real permission asks.
- Generative card content is schema-backed components only — lists with icons, media cards, key-value drafts, choices, editable fields. No arbitrary React/HTML execution in the permission surface.
- `computer_batch` review is action review/execution UI, a separate surface from native permission approval, even if the visual style converges.

## Browser and app extensions

- Extensions deepen the computer tree and interaction quality; they never replace the base computer API. When an extension is missing, unconnected, or unpermitted, Interpreter uses the AX/CUA/screenshot refs it already has when those are sufficient — subject to the denial-parity rule below.
- Denial-parity rule (adopted 2026-07-05): access denial binds the target, not the transport. If a browser profile/page is denied by browser access policy, native CUA/AX/screenshot reads of that same target must also refuse. A fallback path must never become a policy bypass.
- The browser extension relay is an implementation boundary, not the model-facing tool boundary. Model-facing browser tools go through `interpreter-app` and `ToolManager`; relay `/cli/*` routes stay disabled or explicitly gated.
- Chrome control is part of the unified computer API: profiles, windows, tabs, frames, page elements, claim/read/control by profile/page permission. No separate browser-control model surface, no tab-group product concepts.
- Playwright is the advanced engine only after Interpreter has an allowed, exact, claimed tab target. Arbitrary page control stays on `builtin-js-repl` plus `interpreter-browser-control` over CDP unless a narrower builtin is deliberately added behind `ToolManager`.

## Overlay UI invariants

- Overlay windows are click-through by default. Only explicit input/edit/review controls opt into mouse capture, and they release it when inactive. The overlay must never trap the desktop.
- Every full overlay scenario failure path ends in a deterministic debug reset: overlay hidden, mouse capture off, transient state cleared, desktop clickable.
- Visuals stay calm: soft highlights and pulses, no hard flashing. The element ripple while the model is thinking over elements is a deliberate, kept effect.

## Interpreter Realtime Controller (future direction)

This is the seed of Interpreter's own realtime system — the successor to renting the hosted realtime loop. It is staged so the interaction ships before the local-model bet:

1. Living Permission Queue (Phase N3, model-agnostic): multi-step requests become an ordered queue of proposed actions rendered as editable, color-coded, replaceable cards; quick-approve fires only the head item; countdown auto-fire is explicit opt-in with visible cancel. Built against current cloud models.
2. Controller (Phase N4, engine-agnostic): a transport-neutral controller that owns decomposition into proposed action lists, a managed compact-context loop (larger working history, fast-model cleanup, tight moment-specific planning context, post-tool-call updates so completed work is not repeated), commit-on-silence that reuses already-finalized calls, and delegation. Runs on configured cloud fast models first, behind a setting; identifies as the overlay agent over the CLI.
3. Local engine (Phase N5): local ASR plus function-calling models plus llama.cpp placement, swapped in behind the same controller contract, judged against the cloud baseline with real latency/quality measurements.

Scaffolding guardrail: compensation helpers for small models are decomposition scaffolding, not fused convenience tools. Read-file-to-text, read-form-state, and propose-reviewed-batch are separate composable primitives the controller composes; a proposal assembled with helper-model support still crosses the reviewed batch boundary. If a helper only makes sense as one mega-tool that reads, parses, and fills in a single call, it is the wrong design.

## Privacy and provenance

- The community defaults configure no telemetry, analytics, crash reporting, hosted update service, installer ping, or background phone-home for CUA, overlay-controller, hidden-agent, or CLI-tool paths.
- The Interpreter CUA fork preserves its TryCua upstream history and remote. Keep the fork-specific delta narrow and review upstream updates before merging them.
- Interpreter branding only in user-facing and agent-facing copy.

## CUA fork discipline (decided 2026-07-06)

The fork of the upstream computer-use driver stays thin and structurally boring so upstream merges stay cheap. The delta may contain only:

1. **Privacy no-ops** — telemetry, update checks, remote skill fetch, installer pings disabled. These modify upstream files and are the unavoidable, irreducible fork tax; the plan's Private CUA Patch Inventory enumerates every one and the verifier compares it against the live upstream diff before any merge.
2. **Additive tool files** — new capabilities such as the exact-target window tools (`set_window_bounds`, `focus_window`, `close_window`, `minimize_window`, `restore_window`, `maximize_window`) live as self-contained new files plus registry lines. New files cannot conflict with upstream changes, so their merge cost is near zero.

Scattered edits inside upstream logic are not allowed; a genuine upstream bug-behavior fix (for example the popup select matcher) is the rare exception and must be carried explicitly in the patch inventory so every merge re-examines it.

Why driver-side rather than app-side for desktop-action additions: the driver daemon owns single-desktop-action serialization, the AX window/element cache that exact `window_id` targeting verifies against, and focus suppression — window operations implemented outside it would race the action stream and duplicate per-OS native code in the app. The app already has small native helpers, but those are app-UX plumbing; agent-facing desktop actions belong behind the one driver surface with one cross-platform contract (macOS AX, Windows UIA). If upstream later ships equivalent tools, ours are deleted and the app wrapper — which only knows tool names — switches without changes.

## Terminology

Current vocabulary: current selection/context, target identity, permission owner, reviewed batch, agent windows, hidden-agent handoff.

Deprecated vocabulary (internal debt only, never model-facing, scheduled for cleanup): overlay session ids, selected-context snapshot ids and generation counters, the removed synthetic form-fill profile, and old separate overlay route names. If you see these in code or tests, they mark cleanup work, not contracts to build on.
