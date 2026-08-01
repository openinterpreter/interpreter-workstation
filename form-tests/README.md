# Form Tests

Standalone on-screen benchmark harness for the Workstation `Interpreter Overlay`.

## Thesis

This benchmark is not meant to teach the system a single canned workflow.
It exists to pressure-test whether the overlay can treat an unfamiliar GUI as an API.

There are two overlay contracts in the codebase:
- `vision` mode: built-in Responses `computer` loop with screenshots as the primary state updates
- `ax` mode: accessibility-tree serialization plus raw action execution

The product path and the benchmark path both default to `ax` mode.
If you intentionally want to benchmark the old screenshot-driven runtime, set
`INTERPRETER_OVERLAY_AGENT_MODE=vision` before starting the app or local API.

The runtime is responsible for absorbing platform-specific mechanics.
The benchmark must not cheat by reshaping the UI into something easier than a real app.

That means:
- source windows should look like realistic knowledge-work apps
- destination windows should look like realistic CRMs, intake flows, or account forms
- controls should preserve realistic behavior
- some generated apps use native dropdowns
- some generated apps use web-style dropdowns
- the model-facing contract stays the same across both: open the control, refresh context, click the revealed option

Overlay mode env:
- default: `INTERPRETER_OVERLAY_AGENT_MODE=ax`
- opt-in vision: `INTERPRETER_OVERLAY_AGENT_MODE=vision`
- real local-API AX run: `USE_LOCAL_API=true INTERPRETER_OVERLAY_AGENT_MODE=ax pnpm form-tests:auto -- --skip-build --test test-014 --drag-select-form`

The point is generalization:
- if the assistant can succeed here, it should be because the GUI abstraction is good
- not because the benchmark UI was bent into a solver-specific shape

## Current Runtime Contract

### AX mode

This is the default product and form-tests path.

The runtime sends:
- the operator request as text
- accessibility-derived structured state updates
- raw atomic actions for click, type, scroll, hotkey, and screenshot refresh

Important implications:
- AX state is the primary model-facing contract
- scoped runs stay constrained to the selected viewport
- form tests should be evaluated against this path unless you intentionally flip the code-level mode switch above

### Vision mode

This is an explicit code-switch-only debug path.

The server sends:
- the operator request as text
- a live screenshot image in the first user turn
- the built-in Responses `computer` tool

The model returns:
- `computer_call` batches such as `click`, `type`, `scroll`, `keypress`, `double_click`, `wait`, and `screenshot`

The local app:
- executes the entire batch locally
- then captures one fresh screenshot after the batch finishes
- returns that screenshot as the next `computer_call_output`

Important implications:
- screenshots, not AX diffs, are the primary state updates in this mode
- click and scroll coordinates are screenshot pixel coordinates
- form-tests currently discourage keyboard `Tab` navigation between fields and prefer direct clicks

## What It Does

- starts the local `new_api` stack if it is not already running
- launches the built Workstation app in hidden benchmark mode
- opens real Electron source/form windows on screen, or a real Chrome form tab in `--chrome-form` mode
- runs the overlay through a local debug API
- grades actual form state and submission outcome from the benchmark app itself

## Commands

From the repo root:

```bash
pnpm form-tests:generate
pnpm form-tests:auto
pnpm form-tests:server
pnpm form-tests:auto -- --skip-build --test test-001
pnpm form-tests:auto -- --server-api --test test-001
pnpm form-tests:auto -- --continue-on-failure
pnpm form-tests:auto -- --test test-001 --gui-inspect
pnpm form-tests:auto -- --test test-001 --drag-select-form
pnpm form-tests:auto -- --test test-001 --chaos-drag-select-form
pnpm form-tests:auto -- --chrome-form --test test-001
pnpm run form-tests:tahoe -- --test test-001 --drag-select-form
pnpm form-tests:generate -- --seed form-tests-v2
```

### Running on Tahoe

Use `pnpm run form-tests:tahoe -- <form-tests args>` to run the same
`form-tests:auto` harness on the Tahoe VM without recording. The wrapper
syncs this app checkout to the VM, runs the normal form-test command there,
and pulls artifacts back to `.platform-workspace/tahoe/form-tests-output/`.

The default VM target is `admin@192.168.64.7:/Users/admin/overlay-workstation-app`.
Override it with `TAHOE_VM_REMOTE`, `TAHOE_VM_APP_DIR`, or
`TAHOE_FORM_TESTS_ARTIFACT_DIR` when needed.

API mode:

- Default behavior uses the local `new_api` stack and starts it if needed.
- If you want to be explicit, set `USE_LOCAL_API=true`. That is the intended real local-API path for AX form-test verification.
- `--server-api` skips local API startup and runs the benchmark app against the hosted server path instead.
- `--reuse-local-api` only applies to local mode and cannot be combined with `--server-api`.
- Form tests default the overlay LLM to Groq `openai/gpt-oss-120b`.
- Override that with `FORM_TESTS_INTERPRETER_OVERLAY_MODEL` and `FORM_TESTS_INTERPRETER_OVERLAY_LLM_BASE_URL` when you want a different provider/model.

Chrome mode:

- `--chrome-form` opens the destination form in a single real Chrome tab that is reused across the benchmark run.
- Chrome mode uses your normal Chrome profile by default. Pass `--chrome-profile temp` if you want an isolated session instead.
- In Chrome mode, the source document is inlined into the prompt instead of appearing in a second source window.
- Set `FORM_TESTS_CHROME_PATH` if Chrome is not installed at the platform default location.
- `test-012` is a fixed browser-checkout regression fixture with synthetic shipping data. It models the failure mode from a real Chrome checkout flow: address autocomplete plus state/city/ZIP comboboxes that only expose their editable input while focused and hide the committed value from durable AX-style readback after blur.
- `test-013` is a fixed JS-heavy expense-report regression with transient comboboxes, dependent project-code routing, and a more realistic internal-tool layout.
- `test-015` is a fixed overlay screenshot-save regression. It is capture-only and must prove that a normal attached overlay agent launches with a live attached overlay session, explicitly calls `overlay_detach`, and only then does non-overlay work on the saved screenshot path.
- `test-016` is a fixed overlay form-fill regression for `Interpreter Fast`. It must prove that a normal attached overlay agent keeps the live attached overlay session, uses the shared `computer_batch` overlay executor to fill the scoped form, and only detaches after live overlay work is done.

Drag-select overlay test mode:

- `--drag-select-form` keeps the normal graded form-test flow, but first opens the real Interpreter overlay on the electron form surface, derives the form region from AX-captured interactive elements, and performs a real mouse drag across that region.
- `--chaos-drag-select-form` does the full stress version first: dismisses and reopens the overlay, performs multiple aggressive drags around and beyond the form region, asserts the overlay never duplicates or resizes, and then finishes with the proper scope drag.
- In this mode, form tests force AX mode and paste the source contents into the overlay prompt before the run starts.
- CRITICAL: when a normal attached overlay agent is launched, that agent owns a live attached overlay session. The region box / working pill must stay attached until the agent explicitly calls `overlay_detach` or `overlay_complete`. The handoff must not auto-dismiss the overlay immediately after submit.
- CRITICAL: attached overlay cleanup is agent-owned state. Do not auto-complete or auto-detach the live overlay session just because a turn ended, the agent replied, or the runtime is unwinding. If the model finishes without an explicit overlay tool call, that is a real bug and the test should expose it.
- CRITICAL: for attached live overlay fills, `overlay_detach` / `overlay_complete` are terminal. If the agent releases the live overlay before the final visible save/submit action succeeds, it has thrown away its only on-screen control path and the test must fail.
- CRITICAL: the attached overlay agent path must receive the initial AX dump and the scoped screenshot as a saved file path reference instead of an inline image attachment.
- CRITICAL: attached overlay live reads must keep that same contract. `overlay_read_context` / `overlay_screenshot` return AX text plus a saved screenshot file reference. They must not inline fresh screenshot bytes.
- CRITICAL: attached overlay live action execution must use the shared `computer_batch` executor. Do not regress to one-action-at-a-time `overlay_click` / `overlay_type` / `overlay_hotkey` / `overlay_scroll` agent loops.
- CRITICAL: for attached live overlay fill tasks, the initial AX dump and initial saved screenshot are the starting context. If they already identify the visible controls and source values, the agent should begin with `computer_batch` immediately instead of wasting the first live overlay tool call on `overlay_read_context`.
- CRITICAL: for attached live overlay fill tasks, batch as much as possible in each `computer_batch` call while the UI remains stable. The intended behavior is to fill several visible fields in one batch, then reread only when the UI actually changes.
- CRITICAL: attached overlay tool calls must be issued directly as `interpreter-app tools builtin-interpreter-overlay ...`. Do not nest them inside `/bin/zsh -lc`, `bash -lc`, or another shell wrapper. `command_execution` already runs in a shell, and nested wrappers break the launcher path and caller-token propagation.
- The intended verification commands are `USE_LOCAL_API=true INTERPRETER_OVERLAY_AGENT_MODE=ax pnpm form-tests:auto -- --skip-build --test <id> --drag-select-form` and `USE_LOCAL_API=true INTERPRETER_OVERLAY_AGENT_MODE=ax pnpm form-tests:auto -- --skip-build --test <id> --chaos-drag-select-form`.
- It is intended to verify the real scoped-form workflow, not a separate smoke pass.

Manual workbench server:

- `pnpm form-tests:server` starts the standalone browser harness only. It does not build or launch the app and it does not start `new_api`.
- It automatically opens the workbench in Chrome once the server is ready.
- The workbench binds to the first available port in `9930-9959`, which stays clear of the `pnpm run dev:local` Vite/API ports.
- The root page includes a sticky header form picker, inline source brief, embedded live form surface, and auto-grading status.
- It still writes live `task-state.json`, `page-js-trace.*`, and `evaluation.json` files under `form-tests/test-output/<test-id>/`.

## Live Trace Artifacts

Every run writes a live transcript under:

- `form-tests/test-output/conversation-history.live.txt`
- `form-tests/test-output/conversation-history.live.json`
- `form-tests/test-output/conversation-history.live.html`

The live HTML trace is the easiest way to inspect a run. It includes:
- the current system prompt at the top
- the chronological model input / model output / tool dispatch / tool result stream
- screenshots embedded as local file references and image previews
- per-event timings in red
- per-action timings for each executed `computer_batch`

Transcript screenshots are materialized next to the live transcript in:
- `form-tests/test-output/`

The readable traces do not inline base64 image blobs. They point at local image files instead.

Per-test artifacts are still written under:
- `form-tests/test-output/<test-id>/`

Those per-test artifacts include:
- `conversation-history.txt`
- `conversation-history.json`
- `automation-trace.txt`
- `page-js-trace.txt`
- `task-state.json`
- `evaluation.json`

## Timing Interpretation

When a run feels slow, check the live HTML trace first.

The timings are split into:
- model response time
- tool dispatch/result time
- per-action timing inside each local `computer_batch`

In successful runs, the largest cost is usually model-turn latency, not local click/type execution. The HTML trace makes that visible.

## GUI Inspection Mode

Use `--gui-inspect` only when you want to inspect overlay rendering.

- It intentionally slows the run down.
- It only applies to the normal `--mode real` interaction flow.
- It captures the pill-input sequence as `gui-inspect-input-open-*`, `gui-inspect-input-typed-*`, and `gui-inspect-input-thinking-*`.
- It captures full screenshots plus 50px-padded before/after crops for each type-review overlay.
- `before-crop` is the real form control without the overlay. `after-crop` is the same region captured from the display with the overlay visible.
- It only pauses on the first type-review overlay.
- It writes screenshot and overlay-state artifacts under `form-tests/test-output/<test-id>/gui-inspect-review-*`.
- Each inspected type action now writes both `*-review-*` artifacts (before approval) and `*-executing-*` artifacts (while the accepted action is actively executing).
- It is for visual QA only, not benchmark timing or performance comparisons.
- GUI inspection currently supports the default Electron form surface only.

## Notes

- Generation is deterministic from a seed.
- The emergency abort hot corner is the top-left `24x24` pixel region.
- In the current harness, hot-corner abort is effectively immediate once the monitor sees the cursor there.
- Dropdown style is chosen per generated app, not per field.
- The fixed `test-012` checkout regression is always emitted in addition to the procedurally generated matrix.
- The app must already have a valid signed-in session cached, because benchmark mode uses the same local JWT/session flow as the normal app.
- Outputs are written to `form-tests/test-output/`.
- `pnpm form-tests:auto` generates deterministic test configs in memory for each run.
- `pnpm form-tests:generate` writes inspection artifacts under `form-tests/test-output/generated/` by default.
