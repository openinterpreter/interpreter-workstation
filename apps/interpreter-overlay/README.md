# Interpreter Overlay

`Interpreter Overlay` is a general computer-use layer for Workstation.

## Core Idea

The overlay does not try to memorize specific applications.
It turns the live GUI into a model-usable interface:

- capture the visible accessibility tree
- serialize it into a compact XML-like text form
- let the model act on stable element IDs
- translate those actions into real OS-level clicks, typing, and shortcuts

This is a GUI-as-API approach.

The model should reason about:
- what is visibly on screen
- which interactive element ID to use next
- whether it needs a refresh after the UI changes

The runtime should absorb the ugly mechanics:
- native menus
- web popups
- focus changes
- platform-specific interaction quirks

## Interaction Development Rule

Instrumented target first. Full scenario second.

Before changing or debugging overlay clicks, typing, dropdowns, native controls,
AX/UIA targeting, focus handling, or scenario-runner overlay demos:

1. Build or use a small target app that represents the app/control type under
   test before recording another full demo. The target should be disposable,
   minimal, and observable. It must log every relevant target-side event:
   focus, click, input, change, submit, selected value, and current value.
   Native form work starts with a native form logger; browser form work starts
   with a browser form logger; file/drop work starts with a target that logs the
   received drop payload.
2. Manually drive that target through the real product interaction path with
   small code snippets or CLI calls:
   Windows UIA through the real CLI/backend path, macOS AX through the real
   backend path, and browser targets through the overlay executor. Do not prove
   behavior by direct handler calls or DOM edits.
3. Iterate there until the target-side log proves the primitive. This is the
   CUA debug loop for click, type, focus, dropdown, drag, drop, and submit
   behavior.
4. Write the exact command, target-side log output, result, and next step into
   the active debug document.
5. Run the full scenario only after the primitive has been proven against the
   instrumented target.

Full scenario videos are integration proof. They are not the right place to
guess at basic primitive failures.

## Dropdown Principle

Dropdowns are a good example of the contract.

The model should think in this shape:
1. click the dropdown control
2. refresh the accessibility tree
3. inspect the revealed options
4. click the option ID it wants

The model should not have to invent low-level selection tricks.
If the underlying app uses:
- a native popup menu
- a web listbox
- a searchable combobox

the executor should still preserve the same model-facing contract as much as possible.

## Benchmark Philosophy

The benchmark under [`form-tests/`](../../form-tests) is not supposed to optimize for one narrow UI.

It is there to test whether this abstraction generalizes to:
- realistic source applications
- realistic destination applications
- mixed control families
- incomplete information
- partial completion without hallucination

If the benchmark is made easier by replacing realistic UI with solver-shaped UI, it stops being a useful benchmark.

## Attached Agent Contract

The attached live overlay session has one action contract.

- Selected-target and attached overlay agents must go through the same `computer_batch` executor.
- CLI transport does not create a second overlay semantics layer. `interpreter-app tools builtin-interpreter-overlay ...` must enter the same overlay tool lifecycle, approval wait, and execution path as the classic overlay flow.
- That executor must go through the normal Interpreter Overlay review UI and approval path. It must not bypass review or auto-run hidden actions.
- The live overlay stays attached until the agent explicitly calls `overlay_detach` or `overlay_complete`.
- Live overlay reads must return AX text plus saved screenshot file references. They must not inline fresh screenshot bytes for normal agents.

If any of those invariants break, the attached-agent path is no longer the same overlay system.

For manual debugging, the form-tests debug server can create an attached CLI
session after a target region is selected. That command must dismiss the input
composer before the first CLI tool call so review/working UI is rendered by the
same post-submit path the product uses.

## Trace Approval UI Spec

The overlay review UI represents a model-emitted action set as one trace.
An action set is the ordered list of actions produced before the next required
screen reread or screenshot boundary.

Approval:

- `Ctrl` approves the entire visible action set, not only the first action.
- `Esc` rejects the action set.
- The review control is a single pill fixed at the bottom middle of the display
  or selected full-screen scope. It is not attached to individual targets.
- The review pill shows `Esc` to reject and `Ctrl` to accept the trace.
- The thinking state also uses the fixed bottom pill. It must not use shimmer
  text.
- Existing per-action preview affordances remain part of review. The trace is
  additive: it does not remove type previews, placeholder whiteout/masking,
  preview text, target shadows, or the logic that makes predicted input legible
  over existing placeholder text.

Trace drawing:

- Every action in the visible action set is drawn at once.
- In scoped/window-targeted mode, React spatial UI is anchored to the selected
  region itself, not the full screen and not the whole target window. If the
  target window moves, the selected-region overlay moves with it. If another
  native window is placed above the target, the trace must remain sandwiched
  above the owning target window and below the unrelated foreground window.
- Scope bounds and action bounds are display-local DIP coordinates. A
  selected-region-sized pinned world overlay converts them to local CSS
  coordinates by subtracting the selected region bounds. Do not scale these
  values by the display backing scale.
- Every real target is outlined with a thin, square, non-rounded border.
- The selected box, all target boxes, and all connector lines use the same
  randomly chosen primary color for the whole user query. Do not recolor per
  action or per action set within the same query.
- Boxes use a slight dark/tinted fill, but the border remains the main visual
  language.
- Borders are square, full-opacity, and thin. Connector lines use the exact
  same color, opacity, and thickness as the target borders. Do not round the
  trace target boxes.
- Click actions should read more strongly than passive boxes by filling just
  that target square with a more opaque version of the query color.
- Consecutive actions are connected by a thin straight line. The line connects
  the closest corner of the previous action box to the closest corner of the
  next action box.
- As approved actions execute, completed boxes and their trailing connector
  lines disappear from the back of the trace.
- A targetless action, such as a hotkey or synthetic typing action, is shown as
  a fake square field labeled with the action, for example `Press Enter`.
- Synthetic action boxes should be placed between neighboring trace steps when
  possible and must avoid overlapping real target boxes.

Thinking effect:

- While the model is thinking, do not shimmer a sweep across the scope.
- Instead, eligible observed elements inside the selected scope should lightly
  spark at varying opacities using the same random primary color family as the
  trace.
- The effect should feel like the color is rummaging through available elements,
  not like a loading bar.
- Element sparking only happens while the model is thinking. It must not run
  during review or while actions are executing.
