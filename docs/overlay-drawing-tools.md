# Overlay Drawing Tools

Overlay drawing tools are visual-only Interpreter CLI tools for annotating the current granted Interpreter Overlay square.

## Tools

Use the normal CLI surface:

```bash
interpreter-app tools builtin-interpreter-overlay overlay_show_drawings --json '{"annotations":[{"label":"Submit","x":520,"y":650,"width":92,"height":36}]}'
interpreter-app tools builtin-interpreter-overlay overlay_clear_drawings --json '{}'
```

`overlay_show_drawings` replaces any previous drawings. `overlay_clear_drawings` removes them.

## Payload

Each annotation is a rectangle in screen DIP coordinates:

```json
{
  "annotations": [
    {
      "id": "submit",
      "label": "Submit",
      "x": 520,
      "y": 650,
      "width": 92,
      "height": 36
    }
  ]
}
```

`id` and `label` are optional. `x`, `y`, `width`, and `height` are required finite numbers. Width and height must be greater than zero.

## Workflow

Before drawing, get coordinates from one of the observable surfaces:

- `overlay_read_context` for selected overlay refs and screen-DIP bounds.
- `overlay_screenshot` when screenshot inspection is enough.
- `builtin-cua-driver get_ui_elements` when drawing on an app outside the current overlay context and coordinate-enabled UI refs are needed.
- `builtin-cua-driver list_windows` when the drawing depends on app/window bounds.

Do not use drawing tools as interaction tools. They must not click, type, read, retry, approve, or execute user-level actions.

## Smoke Test

With the Electron form-tests debug server running, verify the real CLI path:

```bash
INTERPRETER_OVERLAY_DEBUG_TOKEN=... INTERPRETER_OVERLAY_DEBUG_PORT=9877 node scripts/overlay-drawing-cli-smoke.mjs
```

Or run the scenario wrapper, which starts the hidden Electron debug app first:

```bash
pnpm scenario run overlay-drawing:cli-smoke --target local-mac
```

The smoke creates an attached overlay CLI session, calls `overlay_screenshot` through `interpreter-app tools`, verifies a saved screenshot reference is returned, calls `overlay_show_drawings`, verifies the overlay state contains an active drawing action, calls `overlay_clear_drawings`, and verifies the overlay state is clear.
